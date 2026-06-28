import {
  buildClientWarnings,
  hasDangerousClientNote,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from "./normalize";
import type {
  ClientDirectory,
  ClientDirectoryReadResult,
  ClientIdentityInput,
  ClientIdentityResult,
  ClientRecord,
} from "./types";
import { CLIENT_DIRECTORY_SOURCE } from "./types";

function uniqueRecords(records: ClientRecord[]): ClientRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.sheetName ?? ""}:${record.rowNumber ?? ""}:${record.nombre}:${record.telefonoNormalizado ?? ""}:${record.email ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isBlocked(record: ClientRecord): boolean {
  return Boolean(record.bloqueadoNoReservar) || hasDangerousClientNote(record.notas);
}

function withBlockedStatus(
  records: ClientRecord[],
  confidence: ClientIdentityResult["confidence"],
  matchType: ClientIdentityResult["matchType"],
  readWarnings: string[] = [],
): ClientIdentityResult {
  const matches = uniqueRecords(records);
  const warnings = [
    ...readWarnings,
    ...matches.flatMap((record) =>
      buildClientWarnings({
        notas: record.notas,
        bloqueadoNoReservar: record.bloqueadoNoReservar,
        duplicate: matches.length > 1,
      }),
    ),
  ];

  if (matches.some(isBlocked)) {
    return {
      status: "blocked",
      confidence,
      matchType,
      client: matches[0],
      matches,
      warnings: Array.from(new Set(warnings)),
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      confidence,
      matchType,
      matches,
      warnings: Array.from(new Set(["match ambiguo", ...warnings])),
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  return {
    status: "known",
    confidence,
    matchType,
    client: matches[0],
    matches,
    warnings: Array.from(new Set(warnings)),
    source: CLIENT_DIRECTORY_SOURCE,
  };
}

export class ClientDirectoryService {
  constructor(private readonly directory: ClientDirectory) {}

  async findClientByPhone(phone: string): Promise<ClientIdentityResult> {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      return this.unknown();
    }

    const read = await this.directory.listClients();
    const matches = read.records.filter((record) => {
      const phones = [
        record.telefonoNormalizado,
        record.telefonoMovil,
        record.telefonoFijo,
      ]
        .map((value) => (value ? normalizePhone(value) : null))
        .filter(Boolean);

      return phones.includes(normalized);
    });

    return matches.length > 0
      ? withBlockedStatus(matches, "strong", "phone", read.warnings)
      : this.unknown(read.warnings);
  }

  async findClientByEmail(email: string): Promise<ClientIdentityResult> {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      return this.unknown();
    }

    const read = await this.directory.listClients();
    const matches = read.records.filter(
      (record) => record.email && normalizeEmail(record.email) === normalized,
    );

    return matches.length > 0
      ? withBlockedStatus(matches, "strong", "email", read.warnings)
      : this.unknown(read.warnings);
  }

  async findClientByNameWeak(name: string): Promise<ClientIdentityResult> {
    const normalized = normalizeName(name);
    if (!normalized) {
      return this.unknown();
    }

    const read = await this.directory.listClients();
    const exact = read.records.filter(
      (record) => normalizeName(record.nombre) === normalized,
    );
    if (exact.length > 0) {
      return this.nameOnlySuggestion(exact, "medium", read.warnings);
    }

    const approximate = read.records.filter((record) => {
      const candidate = normalizeName(record.nombre);
      return (
        candidate.length >= 4 &&
        (candidate.includes(normalized) || normalized.includes(candidate))
      );
    });

    return approximate.length > 0
      ? this.nameOnlySuggestion(approximate, "weak", read.warnings)
      : this.unknown(read.warnings);
  }

  async resolveClientIdentity(input: ClientIdentityInput): Promise<ClientIdentityResult> {
    const read = await this.directory.listClients();
    const phone = input.phone ? normalizePhone(input.phone) : undefined;
    if (phone) {
      const matches = read.records.filter((record) => {
        const phones = [
          record.telefonoNormalizado,
          record.telefonoMovil,
          record.telefonoFijo,
        ]
          .map((value) => (value ? normalizePhone(value) : null))
          .filter(Boolean);

        return phones.includes(phone);
      });
      if (matches.length > 0) {
        return withBlockedStatus(matches, "strong", "phone", read.warnings);
      }
    }

    const email = input.email ? normalizeEmail(input.email) : undefined;
    if (email) {
      const matches = read.records.filter(
        (record) => record.email && normalizeEmail(record.email) === email,
      );
      if (matches.length > 0) {
        return withBlockedStatus(matches, "strong", "email", read.warnings);
      }
    }

    const name = input.name ? normalizeName(input.name) : undefined;
    if (name) {
      const exact = read.records.filter(
        (record) => normalizeName(record.nombre) === name,
      );
      if (exact.length > 0) {
        return this.nameOnlySuggestion(exact, "medium", read.warnings);
      }

      const approximate = read.records.filter((record) => {
        const candidate = normalizeName(record.nombre);
        return (
          candidate.length >= 4 &&
          (candidate.includes(name) || name.includes(candidate))
        );
      });
      if (approximate.length > 0) {
        return this.nameOnlySuggestion(approximate, "weak", read.warnings);
      }
    }

    return this.unknown(read.warnings);
  }

  private unknown(warnings: string[] = []): ClientIdentityResult {
    return {
      status: "unknown",
      confidence: "none",
      matchType: "none",
      warnings,
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  private nameOnlySuggestion(
    records: ClientRecord[],
    confidence: Exclude<ClientIdentityResult["confidence"], "strong" | "none">,
    readWarnings: string[] = [],
  ): ClientIdentityResult {
    const result = withBlockedStatus(records, confidence, "name", readWarnings);
    if (result.status === "blocked") {
      return {
        ...result,
        warnings: Array.from(new Set(["coincidencia por nombre; revisar manualmente", ...(result.warnings ?? [])])),
      };
    }

    return {
      ...result,
      status: "ambiguous",
      client: undefined,
      warnings: Array.from(new Set(["coincidencia por nombre; revisar antes de tratar como cliente habitual", ...(result.warnings ?? [])])),
    };
  }
}

export function createStaticClientDirectory(
  records: ClientRecord[],
  warnings: string[] = [],
): ClientDirectory {
  return {
    async listClients(): Promise<ClientDirectoryReadResult> {
      return { records, warnings };
    },
  };
}

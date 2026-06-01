import {
  appendClientDirectoryRow,
  getClientDirectory,
  getClientsSheetName,
} from "./google-sheets-client-directory";
import { normalizeEmail, normalizePhone } from "./normalize";
import { ClientDirectoryService } from "./service";
import { CLIENT_DIRECTORY_SOURCE } from "./types";
import type { ClientDirectory } from "./types";

export type ClientReservationUpsertKind =
  | "created"
  | "created_pending_name"
  | "existing"
  | "skipped_ambiguous"
  | "skipped_blocked"
  | "skipped_invalid_phone"
  | "failed";

export interface ClientUpsertFromConfirmedReservationInput {
  phoneE164: string;
  phoneNormalized: string;
  clientName?: string;
  email?: string;
  reservationId: string;
  petName: string;
  checkIn: string;
  checkOut: string;
  source: "whatsapp_reservation";
  now?: Date;
}

export interface ClientUpsertFromConfirmedReservationResult {
  kind: ClientReservationUpsertKind;
  clientStatus: "known" | "unknown" | "ambiguous" | "blocked";
  clientName?: string;
  rowNumber?: number;
  sheetName?: string;
  matchCount?: number;
  warning?: string;
  source: typeof CLIENT_DIRECTORY_SOURCE;
}

export interface ClientUpsertDeps {
  directory?: ClientDirectory;
  appendClientRow?: (row: string[]) => Promise<{ sheetName?: string; rowNumber?: number }>;
  now?: () => Date;
}

function isUsableClientName(value?: string): boolean {
  const normalized = value?.trim().replace(/\s+/g, " ").toLowerCase();
  return Boolean(
    normalized &&
      normalized.length >= 2 &&
      !["cliente whatsapp", "contacto whatsapp", "whatsapp", "cliente"].includes(normalized),
  );
}

function buildPendingClientName(phoneNormalized: string): string {
  const suffix = phoneNormalized.slice(-4).padStart(4, "*");
  return `Contacto WhatsApp ****${suffix}`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function summarizeReservationId(value: string): string {
  return value.length <= 8 ? "[reservation-id]" : `[reservation-id:${value.slice(-8)}]`;
}

export function buildClientDirectoryRowFromReservation(
  input: ClientUpsertFromConfirmedReservationInput,
  now = input.now ?? new Date(),
): { row: string[]; clientName: string; pendingName: boolean } {
  const phoneNormalized = normalizePhone(input.phoneNormalized) ?? normalizePhone(input.phoneE164);
  if (!phoneNormalized) {
    throw new Error("invalid_phone");
  }

  const pendingName = !isUsableClientName(input.clientName);
  const clientName = pendingName
    ? buildPendingClientName(phoneNormalized)
    : input.clientName!.trim().replace(/\s+/g, " ");
  const email = normalizeEmail(input.email ?? "") ?? "";
  const notes = [
    "Alta automatica por reserva WhatsApp",
    `reservationId ${summarizeReservationId(input.reservationId)}`,
    `mascota ${input.petName}`,
    `estancia ${input.checkIn} a ${input.checkOut}`,
    pendingName ? "nombre pendiente de revision" : undefined,
  ]
    .filter(Boolean)
    .join("; ");

  return {
    clientName,
    pendingName,
    row: [
      "sí",
      formatDate(now),
      "",
      clientName,
      "",
      "",
      input.phoneE164,
      phoneNormalized,
      email,
      notes,
      "false",
      input.source,
      now.toISOString(),
    ],
  };
}

export async function upsertClientFromConfirmedReservation(
  input: ClientUpsertFromConfirmedReservationInput,
  deps: ClientUpsertDeps = {},
): Promise<ClientUpsertFromConfirmedReservationResult> {
  const phoneNormalized = normalizePhone(input.phoneNormalized) ?? normalizePhone(input.phoneE164);
  if (!phoneNormalized) {
    return {
      kind: "skipped_invalid_phone",
      clientStatus: "unknown",
      warning: "invalid_phone",
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  const directory = deps.directory ?? getClientDirectory();
  const directoryService = new ClientDirectoryService(directory);
  const phoneIdentity = await directoryService.findClientByPhone(input.phoneE164);
  const emailIdentity =
    phoneIdentity.status === "unknown" && input.email
      ? await directoryService.findClientByEmail(input.email)
      : undefined;
  const identity =
    phoneIdentity.status !== "unknown" ? phoneIdentity : emailIdentity ?? phoneIdentity;

  if (identity.status === "known") {
    return {
      kind: "existing",
      clientStatus: "known",
      clientName: identity.client?.nombre,
      rowNumber: identity.client?.rowNumber,
      sheetName: identity.client?.sheetName,
      matchCount: identity.matches?.length ?? 1,
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  if (identity.status === "blocked") {
    return {
      kind: "skipped_blocked",
      clientStatus: "blocked",
      rowNumber: identity.client?.rowNumber,
      sheetName: identity.client?.sheetName,
      matchCount: identity.matches?.length ?? 1,
      warning: "client_blocked",
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  if (identity.status === "ambiguous") {
    return {
      kind: "skipped_ambiguous",
      clientStatus: "ambiguous",
      matchCount: identity.matches?.length ?? 0,
      warning: "client_ambiguous",
      source: CLIENT_DIRECTORY_SOURCE,
    };
  }

  const { row, clientName, pendingName } = buildClientDirectoryRowFromReservation(
    {
      ...input,
      phoneNormalized,
    },
    deps.now?.() ?? input.now ?? new Date(),
  );
  const appendResult = await (deps.appendClientRow ?? appendClientDirectoryRow)(row);

  return {
    kind: pendingName ? "created_pending_name" : "created",
    clientStatus: "known",
    clientName,
    rowNumber: appendResult.rowNumber,
    sheetName: appendResult.sheetName ?? getClientsSheetName(),
    warning: pendingName ? "client_name_pending_review" : undefined,
    source: CLIENT_DIRECTORY_SOURCE,
  };
}

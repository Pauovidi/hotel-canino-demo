import { google, type sheets_v4 } from "googleapis";
import { getSheetsAdapterContextFromEnv } from "@/lib/hotel/config";
import { isTruthyCell, normalizeEmail, normalizePhone } from "./normalize";
import type { ClientDirectory, ClientDirectoryReadResult, ClientRecord } from "./types";
import { CLIENTS_SHEET_HEADERS } from "./types";

const GOOGLE_SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"] as const;
const DEFAULT_CLIENTS_SHEET_NAME = "CLIENTES";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export function quoteSheetRange(sheetName: string, range: string): string {
  const escaped = sheetName.replace(/'/g, "''");
  return `'${escaped}'!${range}`;
}

export function getClientsSheetName() {
  return process.env.HOTEL_CLIENTS_SHEET_NAME?.trim() || DEFAULT_CLIENTS_SHEET_NAME;
}

function getCacheTtlMs() {
  const raw = Number.parseInt(process.env.HOTEL_CLIENTS_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

export function readGoogleSheetsClientDirectoryHealth() {
  const context = getSheetsAdapterContextFromEnv("real");
  const hasSpreadsheetId = Boolean(context.spreadsheetId?.trim());
  const hasCredentialSource = Boolean(
    context.accessToken?.trim() || context.serviceAccountJson?.trim(),
  );

  return {
    provider: "google_sheets_client_directory",
    sheetName: getClientsSheetName(),
    configured: hasSpreadsheetId && hasCredentialSource,
    googleSheetsConfigured: hasSpreadsheetId && hasCredentialSource,
    hasSpreadsheetId,
    hasCredentialSource,
    cacheTtlMs: getCacheTtlMs(),
  };
}

export async function createSheetsClient(): Promise<{ client: sheets_v4.Sheets; spreadsheetId: string }> {
  const context = getSheetsAdapterContextFromEnv("real");
  if (!context.spreadsheetId) {
    throw new Error("Falta HOTEL_GOOGLE_SHEETS_SPREADSHEET_ID para leer CLIENTES.");
  }

  if (context.accessToken?.trim()) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: context.accessToken.trim() });
    return {
      client: google.sheets({ version: "v4", auth }),
      spreadsheetId: context.spreadsheetId,
    };
  }

  const auth = new google.auth.GoogleAuth({
    credentials: context.serviceAccountJson
      ? JSON.parse(context.serviceAccountJson)
      : undefined,
    scopes: [...GOOGLE_SHEETS_SCOPES],
  });

  return {
    client: google.sheets({ version: "v4", auth }),
    spreadsheetId: context.spreadsheetId,
  };
}

function readCell(row: string[], index: number): string {
  return String(row[index] ?? "").trim();
}

export function mapClientRow(row: string[], rowNumber: number, sheetName: string): ClientRecord {
  const telefonoFijo = readCell(row, 5);
  const telefonoMovil = readCell(row, 6);
  const telefonoNormalizado =
    normalizePhone(readCell(row, 7)) ??
    normalizePhone(telefonoMovil) ??
    normalizePhone(telefonoFijo) ??
    undefined;
  const rawEmail = readCell(row, 8);
  const email = normalizeEmail(rawEmail) ?? (rawEmail || undefined);

  return {
    activo: isTruthyCell(readCell(row, 0)),
    fechaAlta: readCell(row, 1) || undefined,
    fechaBaja: readCell(row, 2) || undefined,
    nombre: readCell(row, 3),
    telefonoFijo: telefonoFijo || undefined,
    telefonoMovil: telefonoMovil || undefined,
    telefonoNormalizado,
    email,
    notas: readCell(row, 9) || undefined,
    bloqueadoNoReservar: isTruthyCell(readCell(row, 10)),
    origen: readCell(row, 11) || undefined,
    updatedAt: readCell(row, 12) || undefined,
    rowNumber,
    sheetName,
  };
}

function validateHeaders(headerRow: string[]): string[] {
  const normalized = headerRow.map((value) => value.trim().toLowerCase());
  const missing = CLIENTS_SHEET_HEADERS.filter((header) => !normalized.includes(header));
  return missing.length > 0
    ? [`CLIENTES: faltan cabeceras (${missing.join(", ")}).`]
    : [];
}

export class GoogleSheetsClientDirectory implements ClientDirectory {
  private cached?: { expiresAt: number; result: ClientDirectoryReadResult };

  constructor(
    private readonly sheetName = getClientsSheetName(),
    private readonly cacheTtlMs = getCacheTtlMs(),
  ) {}

  async listClients(options?: { refresh?: boolean }): Promise<ClientDirectoryReadResult> {
    const now = Date.now();
    if (!options?.refresh && this.cached && this.cached.expiresAt > now) {
      return this.cached.result;
    }

    const result = await this.readClients();
    this.cached = {
      expiresAt: now + this.cacheTtlMs,
      result,
    };
    return result;
  }

  invalidateCache(): void {
    this.cached = undefined;
  }

  private async readClients(): Promise<ClientDirectoryReadResult> {
    try {
      const { client, spreadsheetId } = await createSheetsClient();
      const response = await client.spreadsheets.values.get({
        spreadsheetId,
        range: quoteSheetRange(this.sheetName, "A:M"),
        majorDimension: "ROWS",
        valueRenderOption: "FORMATTED_VALUE",
      });
      const rows = response.data.values ?? [];
      if (rows.length === 0) {
        return { records: [], warnings: ["CLIENTES existe pero esta vacia."] };
      }

      const warnings = validateHeaders(rows[0] ?? []);
      if (warnings.length > 0) {
        return { records: [], warnings };
      }

      return {
        records: rows
          .slice(1)
          .map((row, index) => mapClientRow(row, index + 2, this.sheetName))
          .filter((record) => record.nombre || record.telefonoNormalizado || record.email),
        warnings: [],
      };
    } catch {
      return {
        records: [],
        warnings: ["CLIENTES no disponible: sheet_unavailable"],
      };
    }
  }
}

let singleton: GoogleSheetsClientDirectory | undefined;

export function getClientDirectory(): ClientDirectory {
  singleton ??= new GoogleSheetsClientDirectory();
  return singleton;
}

export function invalidateClientDirectoryCache(): void {
  singleton?.invalidateCache();
}

export async function appendClientDirectoryRow(
  row: string[],
  sheetName = getClientsSheetName(),
): Promise<{ sheetName: string; rowNumber?: number }> {
  const { client, spreadsheetId } = await createSheetsClient();
  const response = await client.spreadsheets.values.append({
    spreadsheetId,
    range: quoteSheetRange(sheetName, "A:M"),
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });

  invalidateClientDirectoryCache();

  const updatedRange = response.data.updates?.updatedRange;
  const rowNumberMatch = updatedRange?.match(/![A-Z]+(\d+):/i);
  return {
    sheetName,
    rowNumber: rowNumberMatch ? Number.parseInt(rowNumberMatch[1], 10) : undefined,
  };
}

export async function clearClientDirectoryRow(
  rowNumber: number,
  sheetName = getClientsSheetName(),
): Promise<{ sheetName: string; rowNumber: number }> {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error("CLIENTES cleanup requires a valid data row number.");
  }

  const { client, spreadsheetId } = await createSheetsClient();
  await client.spreadsheets.values.clear({
    spreadsheetId,
    range: quoteSheetRange(sheetName, `A${rowNumber}:M${rowNumber}`),
  });
  invalidateClientDirectoryCache();

  return { sheetName, rowNumber };
}

export function resetClientDirectoryForTests(): void {
  if (process.env.NODE_ENV === "test") {
    singleton = undefined;
  }
}

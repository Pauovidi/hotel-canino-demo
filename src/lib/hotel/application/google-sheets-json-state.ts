import type { sheets_v4 } from "googleapis";
import {
  createSheetsClient,
  quoteSheetRange,
} from "@/lib/hotel/clients/google-sheets-client-directory";

const JSON_STATE_HEADERS = ["key", "updated_at", "snapshot_json"] as const;

interface SheetsContext {
  client: sheets_v4.Sheets;
  spreadsheetId: string;
}

export interface GoogleSheetsJsonStateHealth {
  provider: "google_sheets";
  sheetName: string;
  configured: boolean;
  googleSheetsConfigured: boolean;
  hasSpreadsheetId: boolean;
  hasCredentialSource: boolean;
}

export interface JsonStateStoreOptions<T> {
  sheetName: string;
  key: string;
  fallback: T;
  now?: () => Date;
  createSheetsClient?: () => Promise<SheetsContext>;
}

function normalizeSheetTitle(value: string): string {
  return value.trim().toLowerCase();
}

function readGoogleSheetsCredentialsHealth(env: NodeJS.ProcessEnv = process.env) {
  const hasSpreadsheetId = Boolean(env.HOTEL_GOOGLE_SHEETS_SPREADSHEET_ID?.trim());
  const hasAccessToken = Boolean(env.HOTEL_GOOGLE_SHEETS_ACCESS_TOKEN?.trim());
  const hasServiceAccountJson = Boolean(
    (env.HOTEL_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ?? env.GOOGLE_SERVICE_ACCOUNT_JSON)?.trim(),
  );
  const hasServiceAccountParts = Boolean(
    (
      env.HOTEL_GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL ??
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL
    )?.trim() &&
      (
        env.HOTEL_GOOGLE_SHEETS_PRIVATE_KEY ??
        env.GOOGLE_PRIVATE_KEY
      )?.trim(),
  );

  return {
    hasSpreadsheetId,
    hasCredentialSource: hasAccessToken || hasServiceAccountJson || hasServiceAccountParts,
  };
}

export function readGoogleSheetsJsonStateHealth(
  sheetName: string,
  env: NodeJS.ProcessEnv = process.env,
): GoogleSheetsJsonStateHealth {
  const credentials = readGoogleSheetsCredentialsHealth(env);
  const configured = credentials.hasSpreadsheetId && credentials.hasCredentialSource;

  return {
    provider: "google_sheets",
    sheetName,
    configured,
    googleSheetsConfigured: configured,
    hasSpreadsheetId: credentials.hasSpreadsheetId,
    hasCredentialSource: credentials.hasCredentialSource,
  };
}

async function ensureJsonStateSheet(
  context: SheetsContext,
  sheetName: string,
): Promise<void> {
  const response = await context.client.spreadsheets.get({
    spreadsheetId: context.spreadsheetId,
    fields: "sheets.properties",
  });
  const hasSheet = response.data.sheets?.some(
    (sheet) =>
      normalizeSheetTitle(sheet.properties?.title ?? "") === normalizeSheetTitle(sheetName),
  );

  if (!hasSheet) {
    await context.client.spreadsheets.batchUpdate({
      spreadsheetId: context.spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          },
        ],
      },
    });
  }

  await context.client.spreadsheets.values.update({
    spreadsheetId: context.spreadsheetId,
    range: quoteSheetRange(sheetName, "A1:C1"),
    valueInputOption: "RAW",
    requestBody: {
      values: [[...JSON_STATE_HEADERS]],
    },
  });
}

function readCell(row: unknown[], index: number): string {
  return String(row[index] ?? "").trim();
}

export async function readGoogleSheetsJsonState<T>(
  options: JsonStateStoreOptions<T>,
): Promise<T> {
  const context = await (options.createSheetsClient ?? createSheetsClient)();
  await ensureJsonStateSheet(context, options.sheetName);

  const response = await context.client.spreadsheets.values.get({
    spreadsheetId: context.spreadsheetId,
    range: quoteSheetRange(options.sheetName, "A:C"),
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = response.data.values ?? [];
  const row = rows.slice(1).find((candidate) => readCell(candidate, 0) === options.key);
  const rawJson = row ? readCell(row, 2) : "";

  if (!rawJson) {
    return options.fallback;
  }

  try {
    return {
      ...(options.fallback as object),
      ...(JSON.parse(rawJson) as object),
    } as T;
  } catch {
    return options.fallback;
  }
}

export async function writeGoogleSheetsJsonState<T>(
  options: JsonStateStoreOptions<T> & { value: T },
): Promise<void> {
  const context = await (options.createSheetsClient ?? createSheetsClient)();
  await ensureJsonStateSheet(context, options.sheetName);

  const nowIso = (options.now?.() ?? new Date()).toISOString();
  const payload = JSON.stringify({
    ...options.value,
    updatedAt: nowIso,
  });

  const response = await context.client.spreadsheets.values.get({
    spreadsheetId: context.spreadsheetId,
    range: quoteSheetRange(options.sheetName, "A:A"),
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = response.data.values ?? [];
  const existingIndex = rows.findIndex((row) => readCell(row, 0) === options.key);
  const values = [[options.key, nowIso, payload]];

  if (existingIndex >= 0) {
    const rowNumber = existingIndex + 1;
    await context.client.spreadsheets.values.update({
      spreadsheetId: context.spreadsheetId,
      range: quoteSheetRange(options.sheetName, `A${rowNumber}:C${rowNumber}`),
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });
    return;
  }

  await context.client.spreadsheets.values.append({
    spreadsheetId: context.spreadsheetId,
    range: quoteSheetRange(options.sheetName, "A:C"),
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values,
    },
  });
}

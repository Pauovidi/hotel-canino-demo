#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";
import JSZip from "jszip";

const REQUIRED_SHEETS = ["CLIENTES_update_exact", "CLIENT_PETS_import"];
const OPTIONAL_COUNT_SHEETS = [
  "ANIMALES_ambiguos",
  "ANIMALES_sin_match",
  "CLIENTES_sin_match",
];
const CLIENTES_PET_COLUMNS = [
  "MASCOTAS",
  "MASCOTAS_COUNT",
  "MASCOTAS_META",
  "MASCOTAS_MATCH_STATUS",
  "MASCOTAS_SOURCE",
  "MASCOTAS_UPDATED_AT",
];
const READONLY_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const DEFAULT_CLIENTES_SHEET = "CLIENTES";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (item === "--out-dir") {
      args.outDir = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function columnIndex(cellRef) {
  const letters = cellRef.replace(/\d+/g, "");
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + (letter.charCodeAt(0) - 64);
  }
  return value - 1;
}

function readSharedStrings(zip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) {
    return [];
  }

  return file.async("string").then((xml) =>
    Array.from(xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)).map((match) =>
      Array.from(match[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g))
        .map((textMatch) => decodeXml(textMatch[1]))
        .join(""),
    ),
  );
}

function parseWorkbookSheets(workbookXml, relsXml) {
  const rels = new Map(
    Array.from(relsXml.matchAll(/<Relationship\b([^>]+?)\/>/g)).map((match) => {
      const attrs = Object.fromEntries(
        Array.from(match[1].matchAll(/(\w+)="([^"]*)"/g)).map(([, key, value]) => [
          key,
          value,
        ]),
      );
      return [attrs.Id, attrs.Target.replace(/^\/?xl\//, "")];
    }),
  );

  return Array.from(workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]+?)\/>/g)).map((match) => {
    const attrs = Object.fromEntries(
      Array.from(match[1].matchAll(/([\w:]+)="([^"]*)"/g)).map(([, key, value]) => [
        key,
        decodeXml(value),
      ]),
    );
    const relationshipId = attrs["r:id"];
    return {
      name: attrs.name,
      path: `xl/${rels.get(relationshipId)}`,
    };
  });
}

function cellValue(cellXml, sharedStrings) {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1];
  const value = cellXml.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? "";
  if (type === "s") {
    return sharedStrings[Number.parseInt(value, 10)] ?? "";
  }

  if (type === "inlineStr") {
    return Array.from(cellXml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g))
      .map((match) => decodeXml(match[1]))
      .join("");
  }

  return decodeXml(value);
}

function parseSheetRows(xml, sharedStrings) {
  return Array.from(xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g))
    .map((rowMatch) => {
      const row = [];
      for (const cellMatch of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
        const ref = cellMatch[1].match(/\br="([^"]+)"/)?.[1];
        if (!ref) {
          continue;
        }
        row[columnIndex(ref)] = cellValue(cellMatch[0], sharedStrings).trim();
      }
      return row.map((value) => value ?? "");
    })
    .filter((row) => row.some(Boolean));
}

async function readWorkbookTables(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const [sharedStrings, workbookXml, relsXml] = await Promise.all([
    readSharedStrings(zip),
    zip.file("xl/workbook.xml")?.async("string"),
    zip.file("xl/_rels/workbook.xml.rels")?.async("string"),
  ]);

  if (!workbookXml || !relsXml) {
    throw new Error("Workbook metadata not found.");
  }

  const tables = {};
  for (const sheet of parseWorkbookSheets(workbookXml, relsXml)) {
    const xml = await zip.file(sheet.path)?.async("string");
    if (!xml) {
      continue;
    }
    const rows = parseSheetRows(xml, sharedStrings);
    const headers = rows[0] ?? [];
    tables[sheet.name] = {
      headers,
      rows: rows.slice(1).map((row) =>
        Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])),
      ),
    };
  }

  return tables;
}

function numberValue(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redact(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return `${text[0]}***${text.length > 1 ? text.at(-1) : ""}`;
}

function readJsonEnv(names) {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (!raw) {
      continue;
    }
    return JSON.parse(raw);
  }
  return undefined;
}

function readEnv(names) {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) {
      return raw;
    }
  }
  return undefined;
}

function getReadOnlySheetsConfig() {
  const spreadsheetId = readEnv(["HOTEL_GOOGLE_SHEETS_SPREADSHEET_ID"]);
  if (!spreadsheetId) {
    return { available: false, reason: "missing_spreadsheet_id" };
  }

  const accessToken = readEnv(["HOTEL_GOOGLE_SHEETS_ACCESS_TOKEN"]);
  const serviceAccountJson = readJsonEnv([
    "HOTEL_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ]);
  const clientEmail = readEnv([
    "HOTEL_GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  ]);
  const privateKey = readEnv(["HOTEL_GOOGLE_SHEETS_PRIVATE_KEY", "GOOGLE_PRIVATE_KEY"]);

  if (accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return { available: true, spreadsheetId, auth };
  }

  if (serviceAccountJson) {
    return {
      available: true,
      spreadsheetId,
      auth: new google.auth.GoogleAuth({ credentials: serviceAccountJson, scopes: READONLY_SCOPES }),
    };
  }

  if (clientEmail && privateKey) {
    return {
      available: true,
      spreadsheetId,
      auth: new google.auth.GoogleAuth({
        credentials: {
          client_email: clientEmail,
          private_key: privateKey.replace(/\\n/g, "\n"),
        },
        scopes: READONLY_SCOPES,
      }),
    };
  }

  return { available: false, reason: "missing_credentials" };
}

function safeSheetsErrorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    return `google_sheets_${error.code}`;
  }
  return error instanceof Error && error.name ? error.name : "unknown_error";
}

async function readClientsSheetReadOnly() {
  let config;
  try {
    config = getReadOnlySheetsConfig();
  } catch {
    return { sheetAccess: "missing", skipReason: "invalid_credentials_json" };
  }

  if (!config.available) {
    return { sheetAccess: "missing", skipReason: config.reason };
  }

  try {
    const client = google.sheets({ version: "v4", auth: config.auth });
    const sheetName = readEnv(["HOTEL_CLIENTS_SHEET_NAME"]) ?? DEFAULT_CLIENTES_SHEET;
    const [metadata, values] = await Promise.all([
      client.spreadsheets.get({
        spreadsheetId: config.spreadsheetId,
        fields: "sheets.properties.title",
      }),
      client.spreadsheets.values.get({
        spreadsheetId: config.spreadsheetId,
        range: `'${sheetName.replace(/'/g, "''")}'!A1:Z`,
        majorDimension: "ROWS",
        valueRenderOption: "FORMATTED_VALUE",
      }),
    ]);
    const sheetTitles = (metadata.data.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter(Boolean);
    const rows = values.data.values ?? [];
    const headers = (rows[0] ?? []).map((header) => String(header).trim()).filter(Boolean);
    const existingColumns = CLIENTES_PET_COLUMNS.filter((column) => headers.includes(column));

    return {
      sheetAccess: "read_only",
      sheetName,
      clientesRowsRead: Math.max(rows.length - 1, 0),
      clientesHeadersRead: headers.length,
      clientesExistingColumns: existingColumns,
      clientesMissingColumns: CLIENTES_PET_COLUMNS.filter((column) => !headers.includes(column)),
      clientPetsSheetExists: sheetTitles.includes("CLIENT_PETS"),
    };
  } catch (error) {
    return { sheetAccess: "error", errorCode: safeSheetsErrorCode(error) };
  }
}

function buildPlan(tables, filePath) {
  const missingRequiredSheets = REQUIRED_SHEETS.filter((sheet) => !tables[sheet]);
  if (missingRequiredSheets.length > 0) {
    throw new Error(`Missing required sheets: ${missingRequiredSheets.join(", ")}`);
  }

  const clientesRows = tables.CLIENTES_update_exact.rows;
  const petRows = tables.CLIENT_PETS_import.rows;
  const groupedPets = new Map();
  for (const row of petRows) {
    const key = row.CSV_ROW_CLIENTES || row.CLIENTE_NORMALIZADO || row.CLIENTE_NOMBRE;
    if (!key) {
      continue;
    }
    groupedPets.set(key, (groupedPets.get(key) ?? 0) + 1);
  }

  const clientsWithOnePet = clientesRows.filter(
    (row) => numberValue(row.MASCOTAS_COUNT) === 1,
  ).length;
  const clientsWithMultiplePets = clientesRows.filter(
    (row) => (numberValue(row.MASCOTAS_COUNT) ?? 0) > 1,
  ).length;
  const ambiguousRows = tables.ANIMALES_ambiguos?.rows.length ?? 0;
  const animalNoMatchRows = tables.ANIMALES_sin_match?.rows.length ?? 0;
  const clientNoMatchRows = tables.CLIENTES_sin_match?.rows.length ?? 0;

  return {
    generatedAt: new Date().toISOString(),
    sourceFile: path.resolve(filePath),
    requiredSheetsPresent: missingRequiredSheets.length === 0,
    sheetAccess: "missing",
    sheetAccessReason: "not_checked",
    clientesColumnsChecked: false,
    clientesMissingColumns: CLIENTES_PET_COLUMNS,
    clientesExistingColumns: [],
    clientesRowsRead: undefined,
    clientesHeadersRead: undefined,
    clientPetsSheetExists: "unknown",
    counts: {
      clientesToUpdate: clientesRows.length,
      petRowsToImport: petRows.length,
      clientsWithOnePet,
      clientsWithMultiplePets,
      ambiguousRows,
      animalNoMatchRows,
      clientNoMatchRows,
      totalNoMatchRows: animalNoMatchRows + clientNoMatchRows,
      groupedClientsInClientPets: groupedPets.size,
    },
    sheets: Object.fromEntries(
      [...REQUIRED_SHEETS, ...OPTIONAL_COUNT_SHEETS]
        .filter((sheet) => tables[sheet])
        .map((sheet) => [sheet, { rows: tables[sheet].rows.length, headers: tables[sheet].headers }]),
    ),
    redactedSamples: {
      clientesUpdate: clientesRows.slice(0, 3).map((row) => ({
        row: row.CSV_ROW_CLIENTES,
        nombre: redact(row.nombre),
        mascotasCount: row.MASCOTAS_COUNT,
        mascotas: redact(row.MASCOTAS),
        status: row.MASCOTAS_MATCH_STATUS,
      })),
      clientPets: petRows.slice(0, 3).map((row) => ({
        row: row.CSV_ROW_CLIENTES,
        cliente: redact(row.CLIENTE_NOMBRE),
        mascota: redact(row.MASCOTA),
        status: row.MATCH_STATUS,
      })),
    },
  };
}

function applyReadOnlySheetCheck(plan, sheetCheck) {
  return {
    ...plan,
    sheetAccess: sheetCheck.sheetAccess,
    sheetAccessReason: sheetCheck.skipReason ?? sheetCheck.errorCode,
    clientesColumnsChecked: sheetCheck.sheetAccess === "read_only",
    clientesMissingColumns: sheetCheck.clientesMissingColumns ?? plan.clientesMissingColumns,
    clientesExistingColumns: sheetCheck.clientesExistingColumns ?? plan.clientesExistingColumns,
    clientesRowsRead: sheetCheck.clientesRowsRead,
    clientesHeadersRead: sheetCheck.clientesHeadersRead,
    clientPetsSheetExists:
      typeof sheetCheck.clientPetsSheetExists === "boolean"
        ? sheetCheck.clientPetsSheetExists
        : plan.clientPetsSheetExists,
  };
}

function renderMarkdown(plan) {
  return `# CLIENTES + mascotas import plan

Generated at: ${plan.generatedAt}

Source file: ${plan.sourceFile}

## Summary

- Clientes to update: ${plan.counts.clientesToUpdate}
- CLIENT_PETS rows to import: ${plan.counts.petRowsToImport}
- Clients with one pet: ${plan.counts.clientsWithOnePet}
- Clients with multiple pets: ${plan.counts.clientsWithMultiplePets}
- Ambiguous animal rows: ${plan.counts.ambiguousRows}
- Animal no-match rows: ${plan.counts.animalNoMatchRows}
- Client no-match rows: ${plan.counts.clientNoMatchRows}
- Total no-match rows: ${plan.counts.totalNoMatchRows}

## Google Sheets read-only check

- Sheet access: ${plan.sheetAccess}
- Sheet access reason: ${plan.sheetAccessReason ?? "n/a"}
- CLIENT_PETS exists: ${plan.clientPetsSheetExists}
- CLIENTES columns checked: ${plan.clientesColumnsChecked}
- CLIENTES rows read: ${plan.clientesRowsRead ?? "n/a"}
- CLIENTES headers read: ${plan.clientesHeadersRead ?? "n/a"}
- Existing CLIENTES pet columns: ${plan.clientesExistingColumns.length > 0 ? plan.clientesExistingColumns.join(", ") : "none/unknown"}
- Columns to verify/add in CLIENTES: ${plan.clientesMissingColumns.join(", ")}

No Google Sheets writes were performed.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    throw new Error("Usage: npm run clients:pets:plan -- --file <xlsx>");
  }

  const filePath = path.resolve(args.file);
  const tables = await readWorkbookTables(filePath);
  const plan = applyReadOnlySheetCheck(buildPlan(tables, filePath), await readClientsSheetReadOnly());
  const outDir = path.resolve(args.outDir ?? "local-data/reports");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, "clients_pets_import_plan.json"),
    JSON.stringify(plan, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(outDir, "clients_pets_import_plan.md"),
    renderMarkdown(plan),
    "utf8",
  );

  console.log(
    JSON.stringify({
      ok: true,
      reportDir: outDir,
      counts: plan.counts,
      sheetAccess: plan.sheetAccess,
    }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "unknown_error",
    }),
  );
  process.exitCode = 1;
});

#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { google } from "googleapis";
import JSZip from "jszip";
import XLSX from "xlsx";
import {
  MATCH_STATUSES,
  chatbotRuleForPetCount,
  matchAnimalClient,
  normalizeName,
} from "./clients-pets-matching.mjs";

const REQUIRED_FILE_SHEETS = ["CLIENTES_update_exact", "CLIENT_PETS_import"];
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
const SAFE_IMPORT_STATUSES = new Set([
  MATCH_STATUSES.EXACT,
  MATCH_STATUSES.TOKEN_SUBSET_UNIQUE,
]);
const PROBABLE_IMPORT_STATUSES = new Set([MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (item === "--clientes") {
      args.clientes = argv[index + 1];
      index += 1;
    } else if (item === "--animales") {
      args.animales = argv[index + 1];
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
    return {
      name: attrs.name,
      path: `xl/${rels.get(attrs["r:id"])}`,
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

function readTabularFile(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

function readValue(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && String(row[name]).trim()) {
      return String(row[name]).trim();
    }
  }
  const lowerMap = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const key = lowerMap.get(name.toLowerCase());
    if (key && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }
  return "";
}

function uniqueValues(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function parsePetNames(value) {
  return uniqueValues(String(value ?? "").split(/\s*;\s*|\s*,\s*/u));
}

function parsePetsFromMeta(meta, fallback) {
  const fallbackNames = parsePetNames(fallback);
  if (!meta) {
    return fallbackNames.map((name) => ({ name, breed: "", sex: "" }));
  }

  try {
    const parsed = JSON.parse(meta);
    const list = Array.isArray(parsed) ? parsed : parsed?.pets;
    if (Array.isArray(list)) {
      return list
        .map((item) =>
          typeof item === "string"
            ? { name: item, breed: "", sex: "" }
            : {
                name: item.name ?? item.nombre ?? item.mascota ?? "",
                breed: item.breed ?? item.raza ?? "",
                sex: item.sex ?? item.sexo ?? "",
              },
        )
        .filter((pet) => pet.name);
    }
  } catch {
    // Keep fallback parsing for non-JSON metadata from external spreadsheets.
  }

  return fallbackNames.map((name) => ({ name, breed: "", sex: "" }));
}

function clientKey(client) {
  return client.rowNumber || client.normalizedName || client.name;
}

function buildClientsFromRows(rows) {
  const clients = rows
    .map((row, index) => ({
      rowNumber: readValue(row, ["CSV_ROW_CLIENTES", "ROW", "FILA", "__rowNum__"]) || String(index + 2),
      name: readValue(row, ["nombre", "NOMBRE", "CLIENTE_NOMBRE", "CLIENTE", "Cliente", "Name"]),
      phone: readValue(row, ["telefono_normalizado", "TELEFONO_NORMALIZADO", "telefono", "TELÉFONO"]),
      email: readValue(row, ["email", "EMAIL", "correo", "CORREO"]),
      activo: readValue(row, ["activo"]),
      bloqueadoNoReservar: readValue(row, ["bloqueado_no_reservar"]),
      notas: readValue(row, ["notas"]),
    }))
    .filter((client) => client.name);

  const seen = new Set();
  return clients.filter((client) => {
    const key = `${client.rowNumber}|${normalizeName(client.name)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildAnimalGroupsFromRows(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const origin = readValue(row, [
      "ANIMAL_CLIENTE_ORIGEN",
      "CLIENTE",
      "Cliente",
      "cliente",
      "CLIENTE_NOMBRE",
      "NOMBRE_CLIENTE",
    ]);
    const petName = readValue(row, ["MASCOTA", "Mascota", "mascota", "ANIMAL", "Animal"]);
    if (!origin && !petName) {
      return;
    }
    const key = normalizeName(origin || `SIN_CLIENTE_${index + 2}`);
    const group = groups.get(key) ?? {
      origin: origin || "SIN CLIENTE",
      sourceRows: [],
      pets: [],
    };
    group.sourceRows.push(String(index + 2));
    if (petName) {
      group.pets.push({
        name: petName,
        breed: readValue(row, ["RAZA", "Raza", "raza"]),
        sex: readValue(row, ["SEXO", "Sexo", "sexo"]),
        sourceRow: String(index + 2),
      });
    }
    groups.set(key, group);
  });
  return Array.from(groups.values());
}

function buildSourceFromFileTables(tables, filePath) {
  const missing = REQUIRED_FILE_SHEETS.filter((sheet) => !tables[sheet]);
  if (missing.length > 0) {
    throw new Error(`Missing required sheets: ${missing.join(", ")}`);
  }

  const clients = buildClientsFromRows([
    ...(tables.CLIENTES_update_exact?.rows ?? []),
    ...(tables.CLIENTES_sin_match?.rows ?? []),
  ]);
  const groups = new Map();

  for (const row of tables.CLIENT_PETS_import?.rows ?? []) {
    const origin = row.ANIMAL_CLIENTE_ORIGEN || row.CLIENTE_NOMBRE;
    const key = normalizeName(origin);
    if (!key) {
      continue;
    }
    const group = groups.get(key) ?? { origin, sourceRows: [], pets: [] };
    group.sourceRows.push(row.FILA_ORIGEN_ANIMALES || "");
    group.pets.push({
      name: row.MASCOTA,
      breed: row.RAZA,
      sex: row.SEXO,
      sourceRow: row.FILA_ORIGEN_ANIMALES,
    });
    groups.set(key, group);
  }

  for (const sheetName of ["ANIMALES_ambiguos", "ANIMALES_sin_match"]) {
    for (const row of tables[sheetName]?.rows ?? []) {
      const origin = row.ANIMAL_CLIENTE_ORIGEN;
      const key = normalizeName(origin);
      if (!key || groups.has(key)) {
        continue;
      }
      groups.set(key, {
        origin,
        sourceRows: [],
        pets: parsePetsFromMeta(row.MASCOTAS_META, row.MASCOTAS),
      });
    }
  }

  return {
    sourceMode: "file",
    sourceFile: path.resolve(filePath),
    clients,
    animalGroups: Array.from(groups.values()),
    originalSheets: Object.fromEntries(
      Object.entries(tables).map(([sheet, table]) => [sheet, { rows: table.rows.length, headers: table.headers }]),
    ),
  };
}

function buildSourceFromOriginFiles(clientesPath, animalesPath) {
  const clientRows = readTabularFile(clientesPath);
  const animalRows = readTabularFile(animalesPath);
  return {
    sourceMode: "origin_files",
    sourceFile: {
      clientes: path.resolve(clientesPath),
      animales: path.resolve(animalesPath),
    },
    clients: buildClientsFromRows(clientRows),
    animalGroups: buildAnimalGroupsFromRows(animalRows),
    originalSheets: {},
  };
}

function matchAll(source) {
  const matched = source.animalGroups.map((group) => ({
    ...group,
    pets: group.pets.filter((pet) => pet.name),
    match: matchAnimalClient(group.origin, source.clients),
  }));

  return matched.filter((group) => group.pets.length > 0 || group.match.status === MATCH_STATUSES.IGNORED_NOISE);
}

function aggregateByClient(groups, statuses) {
  const aggregate = new Map();
  for (const group of groups) {
    if (!statuses.has(group.match.status) || !group.match.client) {
      continue;
    }
    const client = group.match.client;
    const key = clientKey(client);
    const current = aggregate.get(key) ?? {
      client,
      status: group.match.status,
      tokenMatches: [],
      origins: [],
      pets: [],
    };
    current.origins.push(group.origin);
    if (group.match.tokenMatch) {
      current.tokenMatches.push(group.match.tokenMatch);
    }
    current.pets.push(...group.pets);
    if (current.status !== group.match.status) {
      current.status = statuses.has(MATCH_STATUSES.TOKEN_SUBSET_UNIQUE)
        ? MATCH_STATUSES.TOKEN_SUBSET_UNIQUE
        : group.match.status;
    }
    aggregate.set(key, current);
  }
  return Array.from(aggregate.values()).map((entry) => ({
    ...entry,
    pets: uniquePetObjects(entry.pets),
    origins: uniqueValues(entry.origins),
    tokenMatches: uniqueValues(entry.tokenMatches),
  }));
}

function uniquePetObjects(pets) {
  const seen = new Set();
  return pets.filter((pet) => {
    const key = normalizeName(pet.name);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function petMeta(pets) {
  return JSON.stringify(
    pets.map((pet) => ({
      name: pet.name,
      breed: pet.breed || "",
      sex: pet.sex || "",
      sourceRow: pet.sourceRow || "",
    })),
  );
}

function updateRows(aggregates, generatedAt) {
  return aggregates.map((entry) => ({
    CSV_ROW_CLIENTES: entry.client.rowNumber,
    nombre: entry.client.name,
    telefono_normalizado: entry.client.phone,
    email: entry.client.email,
    CLIENTE_NORMALIZADO: normalizeName(entry.client.name),
    MASCOTAS_COUNT: entry.pets.length,
    MASCOTAS: entry.pets.map((pet) => pet.name).join("; "),
    MASCOTAS_META: petMeta(entry.pets),
    MASCOTAS_MATCH_STATUS: entry.status,
    MASCOTAS_SOURCE: "client_pets_dry_run_v2",
    MASCOTAS_UPDATED_AT: generatedAt,
    MATCH_METHOD: entry.status,
    TOKEN_MATCH: entry.tokenMatches.join("; "),
    ANIMAL_CLIENTE_ORIGEN: entry.origins.join("; "),
    CHATBOT_RULE: chatbotRuleForPetCount(entry.pets.length, entry.status),
  }));
}

function petImportRows(aggregates, statusLabel, generatedAt) {
  return aggregates.flatMap((entry) =>
    entry.pets.map((pet) => ({
      CSV_ROW_CLIENTES: entry.client.rowNumber,
      CLIENTE_NOMBRE: entry.client.name,
      telefono_normalizado: entry.client.phone,
      email: entry.client.email,
      CLIENTE_NORMALIZADO: normalizeName(entry.client.name),
      MASCOTA: pet.name,
      RAZA: pet.breed || "",
      SEXO: pet.sex || "",
      ANIMAL_CLIENTE_ORIGEN: entry.origins.join("; "),
      FILA_ORIGEN_ANIMALES: pet.sourceRow || "",
      MATCH_STATUS: entry.status,
      SOURCE: statusLabel,
      UPDATED_AT: generatedAt,
    })),
  );
}

function reviewPetSummary(group) {
  return group.pets.map((pet) => pet.name).join("; ");
}

function reviewPetBreedSummary(group) {
  return group.pets
    .map((pet) => [pet.name, pet.breed].filter(Boolean).join(" - "))
    .filter(Boolean)
    .join("; ");
}

function ambiguousRows(groups) {
  return groups
    .filter((group) => group.match.status === MATCH_STATUSES.AMBIGUOUS)
    .map((group) => ({
      ANIMAL_CLIENTE_ORIGEN: group.origin,
      ANIMAL_CLIENTE_NORMALIZADO: group.match.normalizedName,
      ANIMAL_TOKEN_KEY: group.match.usefulTokens.join(" "),
      MASCOTAS_COUNT: group.pets.length,
      MASCOTAS: reviewPetSummary(group),
      MASCOTAS_META: petMeta(group.pets),
      MATCH_METHOD: group.match.matchMethod ?? MATCH_STATUSES.AMBIGUOUS,
      TOKEN_MATCH: group.match.tokenMatch ?? "",
      CANDIDATES_COUNT: group.match.candidates.length,
      CLIENTES_CANDIDATOS: group.match.candidates.map((candidate) => candidate.name).join("; "),
      ACCION: "Revisar manualmente; no importar automaticamente.",
    }));
}

function simpleAnimalRows(groups, status, action) {
  return groups
    .filter((group) => group.match.status === status)
    .map((group) => ({
      ANIMAL_CLIENTE_ORIGEN: group.origin,
      ANIMAL_CLIENTE_NORMALIZADO: group.match.normalizedName,
      ANIMAL_TOKEN_KEY: group.match.usefulTokens.join(" "),
      MASCOTAS_COUNT: group.pets.length,
      MASCOTAS: reviewPetSummary(group),
      MASCOTAS_META: petMeta(group.pets),
      ACCION: action,
    }));
}

function clientReviewRows(groups, status) {
  return groups
    .filter((group) => group.match.status === status)
    .map((group) => ({
      Cliente_en_excel_animales: group.origin,
      Mascotas: reviewPetSummary(group),
      Mascotas_con_raza: reviewPetBreedSummary(group),
      Cliente_sugerido_en_CLIENTES:
        status === MATCH_STATUSES.AMBIGUOUS
          ? group.match.candidates.map((candidate) => candidate.name).join("; ")
          : group.match.client?.name ?? "",
      Motivo:
        status === MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN
          ? `Coincide un token unico: ${group.match.tokenMatch}`
          : status === MATCH_STATUSES.AMBIGUOUS
            ? "Hay varios clientes posibles"
            : "No se encontro un cliente razonable",
      Acción_cliente:
        status === MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN
          ? "Confirmar si el cliente sugerido es correcto o indicar el correcto"
          : "Indicar el cliente correcto o si no debe importarse",
      Cliente_correcto: "",
      Comentarios: "",
    }));
}

function unmatchedClients(source, exactAggregates, probableAggregates) {
  const matchedKeys = new Set(
    [...exactAggregates, ...probableAggregates].map((entry) => clientKey(entry.client)),
  );
  return source.clients
    .filter((client) => !matchedKeys.has(clientKey(client)))
    .map((client) => ({
      CSV_ROW_CLIENTES: client.rowNumber,
      nombre: client.name,
      telefono_normalizado: client.phone,
      email: client.email,
      CLIENTE_NORMALIZADO: normalizeName(client.name),
      ACCION: "Sin mascotas asignadas en dry-run v2.",
    }));
}

function countByStatus(groups) {
  const counts = {
    exact: 0,
    token_subset_unique: 0,
    probable_high_unique_token: 0,
    ambiguous: 0,
    missing: 0,
    ignored_noise: 0,
  };
  for (const group of groups) {
    counts[group.match.status] = (counts[group.match.status] ?? 0) + 1;
  }
  return counts;
}

function findMolinaCheck(groups) {
  const group = groups.find((item) => normalizeName(item.origin) === "MOLINA");
  const relatedGroups = groups
    .filter((item) => normalizeName(item.origin).split(" ").includes("MOLINA"))
    .map((item) => ({
      origin: item.origin,
      status: item.match.status,
      suggestedClient: item.match.client?.name ?? "",
      pets: reviewPetSummary(item),
      tokenMatch: item.match.tokenMatch ?? "",
    }));
  if (!group) {
    return { found: false, relatedGroups };
  }
  return {
    found: true,
    status: group.match.status,
    suggestedClient: group.match.client?.name ?? "",
    pets: reviewPetSummary(group),
    tokenMatch: group.match.tokenMatch ?? "",
    relatedGroups,
  };
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

function buildPlan(source, groups, sheetCheck, generatedFiles) {
  const exactAggregates = aggregateByClient(groups, SAFE_IMPORT_STATUSES);
  const probableAggregates = aggregateByClient(groups, PROBABLE_IMPORT_STATUSES);
  return {
    generatedAt: new Date().toISOString(),
    sourceMode: source.sourceMode,
    sourceFile: source.sourceFile,
    sheetAccess: sheetCheck.sheetAccess,
    sheetAccessReason: sheetCheck.skipReason ?? sheetCheck.errorCode,
    clientesColumnsChecked: sheetCheck.sheetAccess === "read_only",
    clientesMissingColumns: sheetCheck.clientesMissingColumns ?? CLIENTES_PET_COLUMNS,
    clientesExistingColumns: sheetCheck.clientesExistingColumns ?? [],
    clientesRowsRead: sheetCheck.clientesRowsRead,
    clientesHeadersRead: sheetCheck.clientesHeadersRead,
    clientPetsSheetExists:
      typeof sheetCheck.clientPetsSheetExists === "boolean" ? sheetCheck.clientPetsSheetExists : "unknown",
    counts: {
      sourceClients: source.clients.length,
      sourceAnimalGroups: source.animalGroups.length,
      ...countByStatus(groups),
      clientesUpdateExact: exactAggregates.length,
      clientesUpdateProbableHigh: probableAggregates.length,
      clientPetsImportExact: petImportRows(exactAggregates, "exact_phase_a", "").length,
      clientPetsImportProbableHigh: petImportRows(probableAggregates, "probable_phase_b", "").length,
      clientsWithoutPetMatch: unmatchedClients(source, exactAggregates, probableAggregates).length,
    },
    phasePlan: {
      phaseA: "Importar exact + token_subset_unique.",
      phaseB: "Importar probable_high_unique_token solo con aprobacion del usuario.",
      phaseC: "Importar correcciones manuales del cliente.",
      neverImport: ["ambiguous", "missing", "ignored_noise"],
    },
    molinaCheck: findMolinaCheck(groups),
    generatedFiles,
  };
}

function renderMarkdown(plan) {
  return `# CLIENTES + mascotas import plan v2

Generated at: ${plan.generatedAt}

Source mode: ${plan.sourceMode}

## Matching summary

- exact: ${plan.counts.exact}
- token_subset_unique: ${plan.counts.token_subset_unique}
- probable_high_unique_token: ${plan.counts.probable_high_unique_token}
- ambiguous: ${plan.counts.ambiguous}
- missing: ${plan.counts.missing}
- ignored_noise: ${plan.counts.ignored_noise}

## Import phases

- Phase A: ${plan.phasePlan.phaseA}
- Phase B: ${plan.phasePlan.phaseB}
- Phase C: ${plan.phasePlan.phaseC}
- Never import: ${plan.phasePlan.neverImport.join(", ")}

## Google Sheets read-only check

- Sheet access: ${plan.sheetAccess}
- Sheet access reason: ${plan.sheetAccessReason ?? "n/a"}
- CLIENT_PETS exists: ${plan.clientPetsSheetExists}
- CLIENTES columns checked: ${plan.clientesColumnsChecked}
- CLIENTES rows read: ${plan.clientesRowsRead ?? "n/a"}
- CLIENTES headers read: ${plan.clientesHeadersRead ?? "n/a"}
- Existing CLIENTES pet columns: ${plan.clientesExistingColumns.length > 0 ? plan.clientesExistingColumns.join(", ") : "none/unknown"}
- Columns to verify/add in CLIENTES: ${plan.clientesMissingColumns.join(", ")}

## Molina check

- Found: ${plan.molinaCheck.found}
- Status: ${plan.molinaCheck.status ?? "n/a"}
- Suggested client: ${plan.molinaCheck.suggestedClient ?? "n/a"}
- Pets: ${plan.molinaCheck.pets ?? "n/a"}

No Google Sheets writes were performed.
`;
}

function addWorksheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name);
  const headers = Object.keys(rows[0] ?? { INFO: "" });
  worksheet.columns = headers.map((header) => ({ header, key: header, width: Math.min(Math.max(header.length + 4, 14), 60) }));
  if (rows.length > 0) {
    worksheet.addRows(rows);
  }
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function writeV2Workbook(filePath, source, groups, generatedAt) {
  const exactAggregates = aggregateByClient(groups, SAFE_IMPORT_STATUSES);
  const probableAggregates = aggregateByClient(groups, PROBABLE_IMPORT_STATUSES);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex dry-run";
  workbook.created = new Date(generatedAt);
  addWorksheet(workbook, "Resumen", [
    { Campo: "exact", Valor: countByStatus(groups).exact },
    { Campo: "token_subset_unique", Valor: countByStatus(groups).token_subset_unique },
    { Campo: "probable_high_unique_token", Valor: countByStatus(groups).probable_high_unique_token },
    { Campo: "ambiguous", Valor: countByStatus(groups).ambiguous },
    { Campo: "missing", Valor: countByStatus(groups).missing },
    { Campo: "ignored_noise", Valor: countByStatus(groups).ignored_noise },
    { Campo: "Fase A", Valor: "Importar exact + token_subset_unique" },
    { Campo: "Fase B", Valor: "Importar probable_high_unique_token solo con aprobacion" },
    { Campo: "Fase C", Valor: "Importar correcciones manuales" },
  ]);
  addWorksheet(workbook, "CLIENTES_update_exact", updateRows(exactAggregates, generatedAt));
  addWorksheet(workbook, "CLIENTES_update_probable_high", updateRows(probableAggregates, generatedAt));
  addWorksheet(workbook, "CLIENT_PETS_import_exact", petImportRows(exactAggregates, "exact_phase_a", generatedAt));
  addWorksheet(workbook, "CLIENT_PETS_import_probableHigh", petImportRows(probableAggregates, "probable_phase_b", generatedAt));
  addWorksheet(workbook, "ANIMALES_ambiguos", ambiguousRows(groups));
  addWorksheet(workbook, "ANIMALES_sin_match", simpleAnimalRows(groups, MATCH_STATUSES.MISSING, "Sin candidato razonable; no importar."));
  addWorksheet(workbook, "ANIMALES_ignored_noise", simpleAnimalRows(groups, MATCH_STATUSES.IGNORED_NOISE, "Ignorar; no importable."));
  addWorksheet(workbook, "CLIENTES_sin_mascota_match", unmatchedClients(source, exactAggregates, probableAggregates));
  addWorksheet(workbook, "Instrucciones_cliente", [
    { Paso: "Fase A", Accion: "Importar exact + token_subset_unique", Detalle: "Seguro para importar en el siguiente prompt." },
    { Paso: "Fase B", Accion: "Revisar probable_high_unique_token", Detalle: "Importar solo si el usuario aprueba esta capa." },
    { Paso: "Excel", Accion: "Nombre de pestana", Detalle: "CLIENT_PETS_import_probableHigh equivale a CLIENT_PETS_import_probable_high por limite de 31 caracteres." },
    { Paso: "Fase C", Accion: "Corregir ambiguos/sin match", Detalle: "No importar automaticamente." },
  ]);
  await workbook.xlsx.writeFile(filePath);
}

async function writeClientReviewWorkbook(filePath, groups, generatedAt) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex dry-run";
  workbook.created = new Date(generatedAt);
  addWorksheet(workbook, "Confirmar_probables_altos", clientReviewRows(groups, MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN));
  addWorksheet(workbook, "Revisar_ambiguos", clientReviewRows(groups, MATCH_STATUSES.AMBIGUOUS));
  addWorksheet(workbook, "Revisar_sin_match", clientReviewRows(groups, MATCH_STATUSES.MISSING));
  addWorksheet(workbook, "Instrucciones", [
    {
      Paso: "1",
      Accion: "Confirmar probables altos",
      Detalle: "Marcar si el cliente sugerido es correcto o escribir el cliente correcto.",
    },
    {
      Paso: "2",
      Accion: "Revisar ambiguos",
      Detalle: "Elegir el cliente correcto entre candidatos o indicar que no se importe.",
    },
    {
      Paso: "3",
      Accion: "Revisar sin match",
      Detalle: "Escribir el cliente correcto si existe o dejar comentario.",
    },
  ]);
  await workbook.xlsx.writeFile(filePath);
}

async function buildSource(args) {
  if (args.clientes && args.animales) {
    return buildSourceFromOriginFiles(args.clientes, args.animales);
  }
  if (args.file) {
    return buildSourceFromFileTables(await readWorkbookTables(path.resolve(args.file)), args.file);
  }
  throw new Error(
    "Usage: npm run clients:pets:plan -- --file <xlsx> OR --clientes <csv/xls/xlsx> --animales <csv/xls/xlsx>",
  );
}

export async function runImportPlan(args) {
  const source = await buildSource(args);
  const groups = matchAll(source);
  const outDir = path.resolve(args.outDir ?? "local-data/reports");
  const generatedAt = new Date().toISOString();
  await fs.mkdir(outDir, { recursive: true });

  const v2Path = path.join(outDir, "cruce_clientes_mascotas_v2.xlsx");
  const reviewPath = path.join(outDir, "mascotas_para_revision_cliente_v2.xlsx");
  await writeV2Workbook(v2Path, source, groups, generatedAt);
  await writeClientReviewWorkbook(reviewPath, groups, generatedAt);

  const plan = buildPlan(source, groups, await readClientsSheetReadOnly(), {
    v2Workbook: v2Path,
    clientReviewWorkbook: reviewPath,
    json: path.join(outDir, "clients_pets_import_plan.json"),
    markdown: path.join(outDir, "clients_pets_import_plan.md"),
  });
  await fs.writeFile(plan.generatedFiles.json, JSON.stringify(plan, null, 2), "utf8");
  await fs.writeFile(plan.generatedFiles.markdown, renderMarkdown(plan), "utf8");
  return plan;
}

async function main() {
  const plan = await runImportPlan(parseArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify({
      ok: true,
      reportDir: path.dirname(plan.generatedFiles.json),
      counts: plan.counts,
      sheetAccess: plan.sheetAccess,
      molinaCheck: {
        found: plan.molinaCheck.found,
        status: plan.molinaCheck.status,
        relatedCount: plan.molinaCheck.relatedGroups?.length ?? 0,
      },
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}

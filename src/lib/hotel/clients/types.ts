export const CLIENT_DIRECTORY_SOURCE = "google_sheets_client_directory" as const;

export const CLIENTS_SHEET_HEADERS = [
  "activo",
  "fecha_alta",
  "fecha_baja",
  "nombre",
  "nif",
  "telefono_fijo",
  "telefono_movil",
  "telefono_normalizado",
  "email",
  "notas",
  "bloqueado_no_reservar",
  "origen",
  "updated_at",
] as const;

export type ClientDirectorySource = typeof CLIENT_DIRECTORY_SOURCE;
export type ClientMatchStatus = "known" | "unknown" | "ambiguous" | "blocked";
export type ClientMatchConfidence = "strong" | "medium" | "weak" | "none";
export type ClientMatchType = "phone" | "email" | "name" | "none";
export type ClientPetsMatchStatus =
  | "exact"
  | "exact_or_token"
  | "token_subset_unique"
  | "probable_high_unique_token"
  | "ambiguous"
  | "missing"
  | "manual_review";

export interface ClientRecord {
  activo?: boolean;
  fechaAlta?: string;
  fechaBaja?: string;
  nombre: string;
  telefonoFijo?: string;
  telefonoMovil?: string;
  telefonoNormalizado?: string;
  email?: string;
  notas?: string;
  bloqueadoNoReservar?: boolean;
  origen?: string;
  updatedAt?: string;
  mascotas?: string[];
  mascotasRaw?: string;
  mascotasCount?: number;
  mascotasMeta?: string;
  mascotasMatchStatus?: ClientPetsMatchStatus;
  mascotasSource?: string;
  mascotasUpdatedAt?: string;
  rowNumber?: number;
  sheetName?: string;
}

export interface ClientDirectoryReadResult {
  records: ClientRecord[];
  warnings: string[];
}

export interface ClientDirectory {
  listClients(options?: { refresh?: boolean }): Promise<ClientDirectoryReadResult>;
}

export interface ClientIdentityInput {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
}

export interface ClientIdentityResult {
  status: ClientMatchStatus;
  confidence: ClientMatchConfidence;
  matchType: ClientMatchType;
  client?: ClientRecord;
  matches?: ClientRecord[];
  warnings?: string[];
  source: ClientDirectorySource;
}

export interface ClientImportRow {
  activo?: string;
  fecha_alta?: string;
  fecha_baja?: string;
  nombre?: string;
  nif?: string;
  telefono_fijo?: string;
  telefono_movil?: string;
  telefono_normalizado?: string;
  email?: string;
  notas?: string;
  bloqueado_no_reservar?: string;
  origen?: string;
  updated_at?: string;
}

export interface ClientImportDryRunReport {
  totalRows: number;
  validPhones: number;
  validEmails: number;
  duplicatePhones: number;
  blockedWarnings: number;
  missingNames: number;
}

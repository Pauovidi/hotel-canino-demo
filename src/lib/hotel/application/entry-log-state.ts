import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveJsonStorePath } from "../persistence/runtime";

export type EntryLogOperationalStatus = "pending" | "managed" | "hidden";
export type EntryLogManagedReason = "gestet" | "removed";

export interface EntryLogOperationalRecord {
  reservationId: string;
  status: EntryLogOperationalStatus;
  managedAt?: string;
  managedReason?: EntryLogManagedReason;
  hiddenAt?: string;
  updatedAt: string;
}

export interface EntryLogOperationalState {
  records: Record<string, EntryLogOperationalRecord>;
  updatedAt: string;
}

function looksLikeReservedStorePayload(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (Array.isArray((value as { conversations?: unknown }).conversations) ||
        Array.isArray((value as { reservations?: unknown }).reservations)),
  );
}

function pathContainsReservedStorePayload(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) {
      return false;
    }

    return looksLikeReservedStorePayload(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return false;
  }
}

function fallbackStatePath(requestedPath: string): string {
  const fallbackPath = path.join(path.dirname(requestedPath), "hotel-entry-log-state.json");
  if (path.resolve(fallbackPath) === path.resolve(requestedPath)) {
    return `${requestedPath}.safe`;
  }
  return fallbackPath;
}

function getStateFile(): string {
  const requestedPath = resolveJsonStorePath({
    fileName: "hotel-entry-log-state.json",
    pathEnv: "HOTEL_ENTRY_LOG_STATE_PATH",
    dirEnv: "HOTEL_ENTRY_LOG_STATE_DIR",
  });
  const reservedStorePaths = [
    resolveJsonStorePath({
      fileName: "hotel-conversations.json",
      pathEnv: "HOTEL_CONVERSATIONS_STORE_PATH",
      dirEnv: "HOTEL_CONVERSATIONS_STORE_DIR",
    }),
    resolveJsonStorePath({
      fileName: "hotel-canino-domain.json",
      pathEnv: "HOTEL_DOMAIN_STORE_PATH",
      dirEnv: "HOTEL_DEMO_STORE_DIR",
    }),
  ];
  const normalizedRequestedPath = path.resolve(requestedPath);
  const collidesWithReservedStore = reservedStorePaths.some(
    (storePath) => path.resolve(storePath) === normalizedRequestedPath,
  );

  if (collidesWithReservedStore) {
    return fallbackStatePath(requestedPath);
  }

  if (pathContainsReservedStorePayload(requestedPath)) {
    return fallbackStatePath(requestedPath);
  }

  return requestedPath;
}

async function ensureStateDirectory(): Promise<void> {
  await mkdir(path.dirname(getStateFile()), { recursive: true });
}

export async function loadEntryLogState(): Promise<EntryLogOperationalState> {
  await ensureStateDirectory();

  try {
    const raw = await readFile(getStateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<EntryLogOperationalState>;
    if (looksLikeReservedStorePayload(parsed)) {
      return {
        records: {},
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      records: parsed.records ?? {},
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return {
      records: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveEntryLogState(state: EntryLogOperationalState): Promise<void> {
  await ensureStateDirectory();
  const payload = JSON.stringify(
    {
      ...state,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const tempFile = `${getStateFile()}.tmp`;
  await writeFile(tempFile, payload, "utf8");
  await rm(getStateFile(), { force: true });
  await rename(tempFile, getStateFile());
}

export async function markEntryLogManaged(
  reservationId: string,
  reason: EntryLogManagedReason = "gestet",
): Promise<EntryLogOperationalRecord> {
  const state = await loadEntryLogState();
  const now = new Date().toISOString();
  const record: EntryLogOperationalRecord = {
    reservationId,
    status: "managed",
    managedAt: now,
    managedReason: reason,
    updatedAt: now,
  };
  state.records[reservationId] = record;
  await saveEntryLogState(state);
  return record;
}

export async function hideEntryLogRecord(
  reservationId: string,
  reason: EntryLogManagedReason = "removed",
): Promise<EntryLogOperationalRecord> {
  const state = await loadEntryLogState();
  const now = new Date().toISOString();
  const previous = state.records[reservationId];
  const record: EntryLogOperationalRecord = {
    reservationId,
    status: "hidden",
    managedAt: previous?.managedAt ?? now,
    managedReason: reason,
    hiddenAt: now,
    updatedAt: now,
  };
  state.records[reservationId] = record;
  await saveEntryLogState(state);
  return record;
}

export async function reopenEntryLogRecord(
  reservationId: string,
): Promise<EntryLogOperationalRecord> {
  const state = await loadEntryLogState();
  const now = new Date().toISOString();
  const record: EntryLogOperationalRecord = {
    reservationId,
    status: "pending",
    updatedAt: now,
  };
  state.records[reservationId] = record;
  await saveEntryLogState(state);
  return record;
}

export async function cleanManagedEntryLogRecords(): Promise<{ hidden: number }> {
  const state = await loadEntryLogState();
  const now = new Date().toISOString();
  let hidden = 0;

  for (const [reservationId, record] of Object.entries(state.records)) {
    if (record.status === "managed") {
      state.records[reservationId] = {
        ...record,
        status: "hidden",
        hiddenAt: now,
        updatedAt: now,
      };
      hidden += 1;
    }
  }

  await saveEntryLogState(state);
  return { hidden };
}

export async function resetEntryLogStateForTests(): Promise<void> {
  await rm(getStateFile(), { force: true });
}

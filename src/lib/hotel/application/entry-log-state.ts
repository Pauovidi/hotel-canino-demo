import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function getStateFile(): string {
  return resolveJsonStorePath({
    fileName: "hotel-entry-log-state.json",
    pathEnv: "HOTEL_ENTRY_LOG_STATE_PATH",
    dirEnv: "HOTEL_ENTRY_LOG_STATE_DIR",
  });
}

async function ensureStateDirectory(): Promise<void> {
  await mkdir(path.dirname(getStateFile()), { recursive: true });
}

export async function loadEntryLogState(): Promise<EntryLogOperationalState> {
  await ensureStateDirectory();

  try {
    const raw = await readFile(getStateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<EntryLogOperationalState>;
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

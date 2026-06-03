import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveJsonStorePath } from "../persistence/runtime";

import {
  DEMO_REMINDER_QUEUE,
  DEMO_RESERVATION_RECORDS,
  DEMO_SHEET_SNAPSHOTS,
} from "../mock-data";
import {
  readGoogleSheetsJsonState,
  readGoogleSheetsJsonStateHealth,
  writeGoogleSheetsJsonState,
} from "./google-sheets-json-state";
import { readHotelPersistenceConfig } from "../persistence/runtime";
import type { ReminderJob, ReservationRecord } from "../domain/contracts";
import type { DemoLogEntry, DemoStoreState } from "./types";

const DOMAIN_STORE_KEY = "hotel_canino_domain_state";
const DEFAULT_DOMAIN_STORE_SHEET_NAME = "RESERVATION_RECORDS";

type OperationalStoreProvider = "google_sheets" | "file";

function normalizeOperationalProvider(value?: string): OperationalStoreProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "google_sheets" || normalized === "google-sheets" || normalized === "sheets") {
    return "google_sheets";
  }

  if (
    normalized === "file" ||
    normalized === "file-local" ||
    normalized === "file-volume" ||
    normalized === "local" ||
    normalized === "tmp"
  ) {
    return "file";
  }

  return undefined;
}

function getDomainStoreSheetName(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.HOTEL_DOMAIN_STORE_SHEET_NAME?.trim() ||
    env.HOTEL_RESERVATION_STORE_SHEET_NAME?.trim() ||
    DEFAULT_DOMAIN_STORE_SHEET_NAME
  );
}

function shouldUseGoogleSheetsDomainStore(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitProvider = normalizeOperationalProvider(
    env.HOTEL_DOMAIN_STORE_PROVIDER ?? env.HOTEL_RESERVATION_STORE_PROVIDER,
  );
  if (explicitProvider === "google_sheets") {
    return true;
  }
  if (explicitProvider === "file") {
    return false;
  }
  if (env.NODE_ENV === "test") {
    return false;
  }

  const persistence = readHotelPersistenceConfig(env);
  const health = readGoogleSheetsJsonStateHealth(getDomainStoreSheetName(env), env);
  return Boolean(env.VERCEL || persistence.provider === "file-tmp") && health.configured;
}

export function readReservationStoreHealth(env: NodeJS.ProcessEnv = process.env) {
  const sheetName = getDomainStoreSheetName(env);
  const googleSheets = readGoogleSheetsJsonStateHealth(sheetName, env);
  const explicitProvider = normalizeOperationalProvider(
    env.HOTEL_DOMAIN_STORE_PROVIDER ?? env.HOTEL_RESERVATION_STORE_PROVIDER,
  );
  const useGoogleSheets = shouldUseGoogleSheetsDomainStore(env);

  return {
    provider:
      explicitProvider === "google_sheets" || useGoogleSheets
        ? "google_sheets"
        : readHotelPersistenceConfig(env).provider,
    sheetName,
    configured:
      explicitProvider === "google_sheets" || useGoogleSheets ? googleSheets.configured : true,
    googleSheetsConfigured: googleSheets.configured,
    hasSpreadsheetId: googleSheets.hasSpreadsheetId,
    hasCredentialSource: googleSheets.hasCredentialSource,
    filePath: explicitProvider === "google_sheets" || useGoogleSheets ? undefined : getStoreFile(),
  };
}

function getStoreDirectory(): string {
  return path.dirname(getStoreFile());
}

function getStoreFile(): string {
  return resolveJsonStorePath({
    fileName: "hotel-canino-domain.json",
    pathEnv: "HOTEL_DOMAIN_STORE_PATH",
    dirEnv: "HOTEL_DEMO_STORE_DIR",
  });
}

const initialState: DemoStoreState = {
  reservations: DEMO_RESERVATION_RECORDS,
  reminders: DEMO_REMINDER_QUEUE,
  monthSnapshots: DEMO_SHEET_SNAPSHOTS.map((snapshot) => ({
    sheetName: snapshot.sheetName,
    monthKey: snapshot.monthKey,
    capacityPerSlot: snapshot.capacityPerSlot,
    occupied: Object.fromEntries(
      Object.entries(snapshot.occupied).map(([date, value]) => [
        date,
        {
          morning: value.morning,
          afternoon: value.afternoon,
        },
      ]),
    ),
  })),
  logs: [],
  updatedAt: new Date().toISOString(),
};

async function ensureStoreDirectory(): Promise<void> {
  await mkdir(getStoreDirectory(), { recursive: true });
}

async function seedIfNeeded(): Promise<void> {
  if (shouldUseGoogleSheetsDomainStore()) {
    return;
  }

  try {
    await readFile(getStoreFile(), "utf8");
  } catch {
    await saveDemoState(initialState);
  }
}

export async function loadDemoState(): Promise<DemoStoreState> {
  if (shouldUseGoogleSheetsDomainStore()) {
    return readGoogleSheetsJsonState({
      sheetName: getDomainStoreSheetName(),
      key: DOMAIN_STORE_KEY,
      fallback: initialState,
    });
  }

  await ensureStoreDirectory();
  await seedIfNeeded();

  try {
    const raw = await readFile(getStoreFile(), "utf8");
    return {
      ...initialState,
      ...(JSON.parse(raw) as DemoStoreState),
    };
  } catch {
    return initialState;
  }
}

export async function saveDemoState(state: DemoStoreState): Promise<void> {
  if (shouldUseGoogleSheetsDomainStore()) {
    await writeGoogleSheetsJsonState({
      sheetName: getDomainStoreSheetName(),
      key: DOMAIN_STORE_KEY,
      fallback: initialState,
      value: state,
    });
    return;
  }

  await ensureStoreDirectory();
  const payload = JSON.stringify(
    {
      ...state,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const tempFile = `${getStoreFile()}.tmp`;

  await writeFile(tempFile, payload, "utf8");
  await rm(getStoreFile(), { force: true });
  await rename(tempFile, getStoreFile());
}

export async function appendLog(
  entry: Omit<DemoLogEntry, "id" | "at">,
): Promise<DemoLogEntry> {
  const state = await loadDemoState();
  const logEntry: DemoLogEntry = {
    ...entry,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
  };

  state.logs = [logEntry, ...state.logs].slice(0, 100);
  await saveDemoState(state);
  return logEntry;
}

export async function upsertReservation(
  reservation: ReservationRecord,
): Promise<void> {
  const state = await loadDemoState();
  state.reservations = [
    reservation,
    ...state.reservations.filter(
      (item) => item.reservationId !== reservation.reservationId,
    ),
  ];
  await saveDemoState(state);
}

export async function findReservationById(
  reservationId: string,
): Promise<ReservationRecord | null> {
  const state = await loadDemoState();
  return (
    state.reservations.find((item) => item.reservationId === reservationId) ?? null
  );
}

export async function upsertReminder(
  reminder: ReminderJob,
): Promise<void> {
  const state = await loadDemoState();
  state.reminders = [
    reminder,
    ...state.reminders.filter((item) => item.reminderId !== reminder.reminderId),
  ];
  await saveDemoState(state);
}

export async function markReminder(
  reminderId: string,
  updater: (reminder: ReminderJob) => ReminderJob,
): Promise<ReminderJob | null> {
  const state = await loadDemoState();
  const reminder = state.reminders.find((item) => item.reminderId === reminderId);

  if (!reminder) {
    return null;
  }

  const nextReminder = updater(reminder);
  state.reminders = [
    nextReminder,
    ...state.reminders.filter((item) => item.reminderId !== reminderId),
  ];
  await saveDemoState(state);
  return nextReminder;
}

export async function replaceRemindersForReservation(
  reservationId: string,
  reminders: ReminderJob[],
): Promise<void> {
  const state = await loadDemoState();
  state.reminders = [
    ...reminders,
    ...state.reminders.filter((item) => item.reservationId !== reservationId),
  ];
  await saveDemoState(state);
}

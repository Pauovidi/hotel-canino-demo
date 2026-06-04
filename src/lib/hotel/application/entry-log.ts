import { loadDemoState } from "./demo-store";
import { loadEntryLogState, type EntryLogManagedReason, type EntryLogOperationalStatus } from "./entry-log-state";
import type { ReservationRecord } from "../domain/contracts";

export interface EntryLogRecord {
  reservationId: string;
  displayRef: string;
  reservationSummary: string;
  createdAt: string;
  source: "chatbot" | "formulario" | "recepción email" | "manual/revisión";
  action: "confirmada" | "modificada" | "rechazada" | "cancelada" | "revisión manual";
  clientName: string;
  clientStatus:
    | "cliente habitual"
    | "nuevo contacto"
    | "nuevo cliente añadido"
    | "cliente existente actualizado"
    | "alta CLIENTES pendiente"
    | "revisión manual";
  phoneNormalized: string;
  phoneDisplay: string;
  email: string;
  petName: string;
  petCount: number;
  checkInDate: string;
  checkInTime: string;
  checkOutDate: string;
  checkOutTime: string;
  price: string;
  priceSource: "calculado" | "sin precio";
  wantsVisit: "sí" | "no" | "sin responder";
  notes: string;
  gestetStatus: "pendiente Gestet" | "procesado Gestet";
  operationalStatus: EntryLogOperationalStatus;
  managedAt?: string;
  managedReason?: EntryLogManagedReason;
  hiddenAt?: string;
}

function normalizePhone(value?: string): string {
  return value?.replace(/[^\d+]/g, "") || "Pendiente";
}

function maskPhone(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) {
    return "Pendiente";
  }

  return `***${digits.slice(-4)}`;
}

function displayEmail(value?: string): string {
  return value?.trim() || "Pendiente";
}

function displayTime(value?: string): string {
  return value?.trim() || "Pendiente";
}

function displayPrice(record: ReservationRecord): string {
  return record.pricing?.total !== undefined ? `${record.pricing.total} €` : "Pendiente";
}

function displayVisit(value: ReservationRecord["wantsVisit"]): EntryLogRecord["wantsVisit"] {
  if (value === true) {
    return "sí";
  }
  if (value === false) {
    return "no";
  }
  return "sin responder";
}

function displayReservationRef(value: string): string {
  return value.length <= 8 ? value : `...${value.slice(-8)}`;
}

function reservationSummary(record: ReservationRecord): string {
  return `${record.petName ?? "Mascota"} · ${record.checkInDate} → ${record.checkOutDate}`;
}

function mapSource(record: ReservationRecord): EntryLogRecord["source"] {
  if (record.source === "web") {
    return "formulario";
  }

  if (record.source === "manual") {
    return "manual/revisión";
  }

  if (record.source === "demo") {
    return "chatbot";
  }

  return "recepción email";
}

function mapAction(record: ReservationRecord): EntryLogRecord["action"] {
  if (
    record.status === "confirmada" &&
    record.workflowTrail?.some((step) =>
      step.reason?.toLowerCase().includes("modificacion conversacional"),
    )
  ) {
    return "modificada";
  }

  if (record.status === "confirmada") {
    return "confirmada";
  }

  if (record.status === "cancelada") {
    return "cancelada";
  }

  if (record.status === "sin_disponibilidad") {
    return "rechazada";
  }

  if (record.reviewState === "necesita_revision" || record.manualFollowupRequired) {
    return "revisión manual";
  }

  return "modificada";
}

function mapClientStatus(record: ReservationRecord): EntryLogRecord["clientStatus"] {
  if (record.reviewState === "necesita_revision" || record.manualFollowupRequired) {
    return "revisión manual";
  }

  if (record.clientDirectoryUpsertKind === "existing") {
    return "cliente existente actualizado";
  }

  if (
    record.clientDirectoryUpsertKind === "created" ||
    record.clientDirectoryUpsertKind === "created_pending_name"
  ) {
    return "nuevo cliente añadido";
  }

  if (
    record.clientDirectoryUpsertKind === "failed" ||
    record.clientDirectoryUpsertKind?.startsWith("skipped_")
  ) {
    return "alta CLIENTES pendiente";
  }

  if (record.clientKind === "new") {
    return "nuevo contacto";
  }

  if (record.source === "email" || record.clientKind === "habitual") {
    return "cliente habitual";
  }

  return "nuevo contacto";
}

export function buildEntryLogRecord(record: ReservationRecord): EntryLogRecord {
  const notes = [
    record.notes,
    record.foodNotes ? `Alimentación: ${record.foodNotes}` : undefined,
    record.medicationNotes ? `Medicación: ${record.medicationNotes}` : undefined,
    record.specialNotes,
    record.checkInTimeAdjustmentMessage,
    record.checkOutTimeAdjustmentMessage,
  ].filter(Boolean);

  return {
    reservationId: record.reservationId,
    displayRef: displayReservationRef(record.reservationId),
    reservationSummary: reservationSummary(record),
    createdAt: record.createdAt,
    source: mapSource(record),
    action: mapAction(record),
    clientName: record.ownerName ?? "Cliente pendiente",
    clientStatus: mapClientStatus(record),
    phoneNormalized: normalizePhone(record.phone),
    phoneDisplay: maskPhone(normalizePhone(record.phone)),
    email: displayEmail(record.ownerEmail),
    petName: record.petName ?? "Mascota pendiente",
    petCount: record.petCount,
    checkInDate: record.checkInDate,
    checkInTime: displayTime(record.checkInTime ?? record.originalRequestedCheckInTime),
    checkOutDate: record.checkOutDate,
    checkOutTime: displayTime(record.checkOutTime ?? record.originalRequestedCheckOutTime),
    price: displayPrice(record),
    priceSource: record.priceSource === "calculated" ? "calculado" : "sin precio",
    wantsVisit: displayVisit(record.wantsVisit),
    notes: notes.join(" · ") || "Sin notas",
    gestetStatus: record.sheetRegistration ? "procesado Gestet" : "pendiente Gestet",
    operationalStatus: "pending",
  };
}

export async function listEntryLogRecords(
  options: { status?: "pending" | "managed" | "all" } = {},
): Promise<EntryLogRecord[]> {
  let state: Awaited<ReturnType<typeof loadDemoState>>;

  try {
    state = await loadDemoState();
  } catch {
    return [];
  }

  const operationalState = await loadEntryLogState();
  const status = options.status ?? "pending";

  return state.reservations
    .filter((record) =>
      ["confirmada", "cancelada", "sin_disponibilidad"].includes(record.status) ||
      record.reviewState === "necesita_revision" ||
      record.manualFollowupRequired,
    )
    .map((reservation) => {
      const record = buildEntryLogRecord(reservation);
      const operational = operationalState.records[record.reservationId];
      return {
        ...record,
        operationalStatus: operational?.status ?? "pending",
        managedAt: operational?.managedAt,
        managedReason: operational?.managedReason,
        hiddenAt: operational?.hiddenAt,
      };
    })
    .filter((record) => {
      if (status === "all") {
        return true;
      }

      if (status === "managed") {
        return record.operationalStatus === "managed";
      }

      return record.operationalStatus === "pending";
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

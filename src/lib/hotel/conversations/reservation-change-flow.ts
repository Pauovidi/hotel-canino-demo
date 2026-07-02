import { randomUUID } from "node:crypto";
import { loadDemoState, upsertReservation } from "@/lib/hotel/application/demo-store";
import { mapLegacyAvailabilityToDomain, toLegacyReservationRecord } from "@/lib/hotel/application/integration-bridge";
import { getHotelFeatureFlags, getHotelRuntimeConfig } from "@/lib/hotel/config";
import type { PricingQuote as DomainPricingQuote, ReservationRecord } from "@/lib/hotel/domain/contracts";
import { mapLegacyReservationStatusToWorkflowState, type ReservationWorkflowState } from "@/lib/hotel/domain/states";
import { quoteStayPrice } from "@/lib/hotel/pricing/engine";
import type { PricingQuote } from "@/lib/hotel/pricing/types";
import { buildGoogleSheetAdapter, buildMockSheetAdapter } from "@/lib/hotel/sheets";
import type { SheetAdapter, SheetsWriteResult } from "@/lib/hotel/sheets/types";
import type { ConversationReplyPlan } from "./nlu";
import { renderConversationReplyPlan } from "./authority/copy-renderer";
import { isAffirmativeConfirmationUtterance } from "./nlu";
import { isReservationFlowRejection } from "./reservation-flow";
import type { WhatsAppReservationBridgeDeps } from "./reservation-bridge";
import type {
  ConversationRecord,
  PendingReservationCancellationFlow,
  PendingReservationModificationFlow,
} from "./types";

const CHANGE_FLOW_TTL_MS = 2 * 60 * 60 * 1000;

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

type ChangeKind = "modification" | "cancellation";

interface TargetResolution {
  kind: "none" | "single" | "multiple";
  reservations: ReservationRecord[];
}

export interface ReservationChangeFlowOutcome {
  conversation: ConversationRecord;
  reply: string;
  eventType: string;
  eventPayload?: Record<string, unknown>;
  handoff?: boolean;
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;:()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digits(value?: string): string {
  return value?.replace(/[^\d]/g, "") ?? "";
}

function appendSpecialNote(current: string | undefined, note: string): string {
  return [current, note].filter(Boolean).join(" ");
}

function appendWorkflowTrail(
  reservation: ReservationRecord,
  reason: string,
  now: string,
  to: ReservationWorkflowState = "confirmed",
) {
  const from =
    reservation.workflowState ?? mapLegacyReservationStatusToWorkflowState(reservation.status);
  return [
    ...(reservation.workflowTrail ?? []),
    {
      from,
      to,
      at: now,
      reason,
    },
  ];
}

function safeReservationRef(value?: string): string | undefined {
  if (!value) return undefined;
  return value.length <= 8 ? "[reservation-id]" : `[reservation-id:${value.slice(-8)}]`;
}

function resolveYear(rawYear: string | undefined, now: Date, month: number, day: number): number {
  const normalized = normalize(rawYear ?? "");
  if (normalized === "este ano" || normalized === "de este ano") return now.getUTCFullYear();
  if (
    normalized === "ano que viene" ||
    normalized === "el ano que viene" ||
    normalized === "siguiente ano" ||
    normalized === "proximo ano"
  ) {
    return now.getUTCFullYear() + 1;
  }
  if (normalized) return Number.parseInt(normalized, 10);

  const currentYear = now.getUTCFullYear();
  const today = Date.UTC(currentYear, now.getUTCMonth(), now.getUTCDate());
  const candidate = Date.UTC(currentYear, month - 1, day);
  return candidate >= today ? currentYear : currentYear + 1;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateRange(message: string, now = new Date()): { checkIn: string; checkOut: string } | undefined {
  const text = normalize(message);
  const sameMonth = text.match(
    /\b(?:del|desde|entrada\s+el|entrada)\s+(\d{1,2})\s+(?:al|hasta|y\s+salida\s+el|salida\s+el)\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}|este\s+ano|el\s+ano\s+que\s+viene|ano\s+que\s+viene|siguiente\s+ano|proximo\s+ano))?\b/,
  );
  if (sameMonth) {
    const startDay = Number.parseInt(sameMonth[1], 10);
    const endDay = Number.parseInt(sameMonth[2], 10);
    const month = MONTHS[sameMonth[3]];
    if (!month) return undefined;
    const year = resolveYear(sameMonth[4], now, month, startDay);
    const checkIn = isoDate(year, month, startDay);
    const sameYearCheckOut = isoDate(year, month, endDay);
    const checkOut =
      checkIn && sameYearCheckOut && sameYearCheckOut <= checkIn
        ? isoDate(year + 1, month, endDay)
        : sameYearCheckOut;
    return checkIn && checkOut && checkOut > checkIn ? { checkIn, checkOut } : undefined;
  }

  const explicitMonths = text.match(
    /\b(?:del|desde|entrada\s+el|entrada)\s+(\d{1,2})\s+de\s+([a-z]+)\s+(?:al|hasta|y\s+salida\s+el|salida\s+el)\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}|este\s+ano|el\s+ano\s+que\s+viene|ano\s+que\s+viene|siguiente\s+ano|proximo\s+ano))?\b/,
  );
  if (explicitMonths) {
    const startDay = Number.parseInt(explicitMonths[1], 10);
    const startMonth = MONTHS[explicitMonths[2]];
    const endDay = Number.parseInt(explicitMonths[3], 10);
    const endMonth = MONTHS[explicitMonths[4]];
    if (!startMonth || !endMonth) return undefined;
    const year = resolveYear(explicitMonths[5], now, startMonth, startDay);
    const checkIn = isoDate(year, startMonth, startDay);
    const candidateCheckOut = isoDate(year, endMonth, endDay);
    const checkOut =
      checkIn && candidateCheckOut && candidateCheckOut <= checkIn
        ? isoDate(year + 1, endMonth, endDay)
        : candidateCheckOut;
    return checkIn && checkOut && checkOut > checkIn ? { checkIn, checkOut } : undefined;
  }

  return undefined;
}

function parseTimes(message: string): { checkInTime?: string; checkOutTime?: string } {
  const text = normalize(message);
  const entry = text.match(/\b(?:entrada|llegada|dejar(?:lo|la)?)\D{0,20}(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\b/);
  const exit = text.match(/\b(?:salida|recogida|recoger(?:lo|la)?)\D{0,20}(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\b/);
  const pair = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:y|,)\s*(?:salida\s+)?(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\b/);
  const format = (hour?: string, minute?: string) => {
    if (!hour) return undefined;
    const parsedHour = Number.parseInt(hour, 10);
    if (parsedHour < 0 || parsedHour > 23) return undefined;
    return `${String(parsedHour).padStart(2, "0")}:${minute ?? "00"}`;
  };
  return {
    checkInTime: format(entry?.[1] ?? pair?.[1], entry?.[2] ?? pair?.[2]),
    checkOutTime: format(exit?.[1] ?? pair?.[3], exit?.[2] ?? pair?.[4]),
  };
}

function extractPetName(message: string): string | undefined {
  const match =
    message.match(/\b(?:mi\s+)?(?:mascota|perro|perra)\s+(?:se\s+llama|es)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,1})\b/iu) ??
    message.match(/\b(?:para|de)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,1})\b/iu);
  return match?.[1]?.trim();
}

function formatDate(value?: string): string {
  if (!value) return "fecha pendiente";
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function shortRange(record: Pick<ReservationRecord, "checkInDate" | "checkOutDate" | "petName">): string {
  return `${record.petName ?? "tu mascota"} del ${formatDate(record.checkInDate)} al ${formatDate(record.checkOutDate)}`;
}

function isFutureActiveReservation(record: ReservationRecord, now: Date): boolean {
  const checkout = Date.parse(`${record.checkOutDate}T23:59:59.000Z`);
  return record.status === "confirmada" && Number.isFinite(checkout) && checkout >= now.getTime();
}

function matchesConversation(record: ReservationRecord, conversation: ConversationRecord): boolean {
  const recordPhone = digits(record.phone);
  if (recordPhone && recordPhone === conversation.phoneNormalized) return true;
  const email = conversation.clientEmail?.trim().toLowerCase();
  return Boolean(email && record.ownerEmail?.trim().toLowerCase() === email);
}

function matchesMessage(record: ReservationRecord, message: string, replyPlan: ConversationReplyPlan): boolean {
  const normalized = normalize(message);
  const slotPet = replyPlan.slots.petName ?? extractPetName(message);
  const slotReservationId = replyPlan.slots.reservationId;
  const dateRange = parseDateRange(message);

  if (slotReservationId && normalize(record.reservationId).includes(normalize(slotReservationId))) {
    return true;
  }
  if (slotPet && normalize(record.petName ?? "").includes(normalize(slotPet))) {
    return true;
  }
  if (dateRange && record.checkInDate <= dateRange.checkOut && record.checkOutDate >= dateRange.checkIn) {
    return true;
  }
  return Boolean(record.petName && normalized.includes(normalize(record.petName)));
}

async function listReservationRecords(deps?: WhatsAppReservationBridgeDeps): Promise<ReservationRecord[]> {
  if (deps?.listReservationRecords) return deps.listReservationRecords();
  return (await loadDemoState()).reservations;
}

function getDefaultBuildSheetAdapter() {
  return getHotelFeatureFlags().useGoogleSheetsReal
    ? buildGoogleSheetAdapter
    : () => buildMockSheetAdapter("hotel-whatsapp-reservation-change-flow.json");
}

function buildPricingConfig() {
  const runtimeConfig = getHotelRuntimeConfig();
  const halfDaySupplement = runtimeConfig.pricing.halfDaySupplement.amount;
  return {
    currency: "EUR" as const,
    capDogCountAtFour: true,
    rates: {
      1: { dailyRate: runtimeConfig.pricing.tiers[0].nightlyRate, halfDaySupplement },
      2: { dailyRate: runtimeConfig.pricing.tiers[1].nightlyRate, halfDaySupplement },
      3: { dailyRate: runtimeConfig.pricing.tiers[2].nightlyRate, halfDaySupplement },
      4: { dailyRate: runtimeConfig.pricing.tiers[3].nightlyRate, halfDaySupplement },
    },
  };
}

function toDomainPricing(pricing: PricingQuote): DomainPricingQuote {
  return {
    currency: "EUR",
    subtotal: pricing.baseAmount,
    supplements: pricing.halfDayAmount,
    total: pricing.total,
    lineItems: [
      {
        code: `hotel-${pricing.rateBand}-perro`,
        label: `Hotel canino ${pricing.rateBand} perro${pricing.rateBand > 1 ? "s" : ""}`,
        quantity: pricing.fullDays,
        unitPrice: pricing.dailyRate,
        total: pricing.baseAmount,
      },
    ],
    assumptions: [
      "Precio recalculado por noches; las horas se conservan como dato operativo.",
    ],
  };
}

function quoteReservation(input: {
  checkInDate: string;
  checkOutDate: string;
  petCount: number;
}): DomainPricingQuote {
  return toDomainPricing(
    quoteStayPrice(
      {
        stay: {
          checkIn: { date: input.checkInDate, slot: "afternoon" },
          checkOut: { date: input.checkOutDate, slot: "morning" },
        },
        dogs: input.petCount,
      },
      buildPricingConfig(),
    ),
  );
}

function resolveReservations(input: {
  conversation: ConversationRecord;
  records: ReservationRecord[];
  message: string;
  replyPlan: ConversationReplyPlan;
  now: Date;
}): TargetResolution {
  const active = input.records.filter((record) => isFutureActiveReservation(record, input.now));
  const direct = active.filter((record) => matchesMessage(record, input.message, input.replyPlan));
  if (direct.length === 1) return { kind: "single", reservations: direct };
  if (direct.length > 1) return { kind: "multiple", reservations: direct };

  const byConversation = active.filter((record) => matchesConversation(record, input.conversation));
  if (byConversation.length === 1) return { kind: "single", reservations: byConversation };
  if (byConversation.length > 1) return { kind: "multiple", reservations: byConversation };
  return { kind: "none", reservations: [] };
}

function flowBase(conversation: ConversationRecord, now: Date) {
  return {
    flowId: `reservation_change_${randomUUID()}`,
    conversationId: conversation.id,
    phoneNormalized: conversation.phoneNormalized,
    source: "whatsapp" as const,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    expiresAt: new Date(now.getTime() + CHANGE_FLOW_TTL_MS).toISOString(),
  };
}

function expired(expiresAt: string | undefined, now: Date): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) <= now.getTime());
}

function applyModificationFlow(
  conversation: ConversationRecord,
  flow: PendingReservationModificationFlow | undefined,
): ConversationRecord {
  return {
    ...conversation,
    pendingReservationModificationFlow: flow,
    pendingReservationCancellationFlow: undefined,
    pendingReservationProposal: undefined,
    pendingReservationContext: undefined,
    reservationFlow: undefined,
    updatedAt: nowIso(),
  };
}

function applyCancellationFlow(
  conversation: ConversationRecord,
  flow: PendingReservationCancellationFlow | undefined,
): ConversationRecord {
  return {
    ...conversation,
    pendingReservationCancellationFlow: flow,
    pendingReservationModificationFlow: undefined,
    pendingReservationProposal: undefined,
    pendingReservationContext: undefined,
    reservationFlow: undefined,
    updatedAt: nowIso(),
  };
}

function buildMultipleReply(kind: ChangeKind, reservations: ReservationRecord[]): string {
  const action = kind === "modification" ? "modificar" : "cancelar";
  const options = reservations
    .slice(0, 5)
    .map((reservation) => `- ${shortRange(reservation)}`)
    .join("\n");
  return `Tienes varias reservas futuras. ¿Cuál quieres ${action}? Puedes decirme el nombre de la mascota o las fechas.\n${options}`;
}

function buildNoReservationReply(kind: ChangeKind): string {
  return kind === "modification"
    ? "No encuentro una reserva futura asociada a este teléfono. Dime el nombre de la mascota y las fechas aproximadas para localizarla."
    : "No encuentro una reserva futura asociada a este teléfono. Dime el nombre de la mascota y las fechas aproximadas para localizarla antes de cancelarla.";
}

function buildSelectedModificationReply(reservation: ReservationRecord): string {
  return `He encontrado tu reserva para ${shortRange(reservation)}. ¿Qué quieres modificar? Puedo cambiar fechas, horas u observaciones.`;
}

function buildSelectedCancellationReply(reservation: ReservationRecord): string {
  return `He encontrado tu reserva para ${shortRange(reservation)}. ¿Confirmas que quieres cancelarla?`;
}

function withSheetRegistration(record: ReservationRecord, result: SheetsWriteResult, now: string): ReservationRecord {
  return {
    ...record,
    sheetRegistration: {
      sheetName: result.sheetName,
      reservationId: result.reservationId,
      rowHint: result.rowHint,
      cells: result.cellUpdates.map((update) => update.cell),
      writtenAt: now,
    },
  };
}

function updatedReservationFromModification(input: {
  reservation: ReservationRecord;
  flow: PendingReservationModificationFlow;
  writeResult?: SheetsWriteResult;
  availability?: Awaited<ReturnType<SheetAdapter["checkAvailability"]>>;
  nowIso: string;
}): ReservationRecord {
  const next: ReservationRecord = {
    ...input.reservation,
    status: "confirmada",
    workflowState: "confirmed",
    workflowTrail: appendWorkflowTrail(
      input.reservation,
      "Modificacion conversacional confirmada por WhatsApp.",
      input.nowIso,
    ),
    checkInDate: input.flow.requestedCheckInDate ?? input.reservation.checkInDate,
    checkInTime: input.flow.requestedCheckInTime ?? input.reservation.checkInTime,
    checkOutDate: input.flow.requestedCheckOutDate ?? input.reservation.checkOutDate,
    checkOutTime: input.flow.requestedCheckOutTime ?? input.reservation.checkOutTime,
    pricing:
      input.flow.newPrice !== undefined
        ? quoteReservation({
            checkInDate: input.flow.requestedCheckInDate ?? input.reservation.checkInDate,
            checkOutDate: input.flow.requestedCheckOutDate ?? input.reservation.checkOutDate,
            petCount: input.reservation.petCount,
          })
        : input.reservation.pricing,
    priceSource: input.flow.newPrice !== undefined ? "calculated" : input.reservation.priceSource,
    priceNeedsReview: false,
    availability: input.availability
      ? mapLegacyAvailabilityToDomain(input.availability, false)
      : input.reservation.availability,
    updatedAt: input.nowIso,
    specialNotes: appendSpecialNote(
      input.reservation.specialNotes,
      input.flow.requestedNotes
        ? `Modificacion conversacional confirmada. ${input.flow.requestedNotes}`
        : "Modificacion conversacional confirmada.",
    ),
    manualFollowupRequired: false,
  };

  return input.writeResult ? withSheetRegistration(next, input.writeResult, input.nowIso) : next;
}

function updatedReservationFromCancellation(
  reservation: ReservationRecord,
  cancelledAt: string,
): ReservationRecord {
  return {
    ...reservation,
    status: "cancelada",
    workflowState: "cancelled",
    workflowTrail: appendWorkflowTrail(
      reservation,
      "Cancelacion conversacional confirmada por WhatsApp.",
      cancelledAt,
      "cancelled",
    ),
    cancellationRequestedAt: reservation.cancellationRequestedAt ?? cancelledAt,
    cancellationCompletedAt: cancelledAt,
    manualFollowupRequired: false,
    updatedAt: cancelledAt,
    specialNotes: appendSpecialNote(
      reservation.specialNotes,
      "Cancelacion conversacional confirmada y registrada.",
    ),
  };
}

export function isReservationChangeFlowActive(record: ConversationRecord): boolean {
  return Boolean(
    record.pendingReservationModificationFlow &&
      !["confirmed", "cancelled", "manual_review"].includes(record.pendingReservationModificationFlow.status),
  ) || Boolean(
    record.pendingReservationCancellationFlow &&
      !["confirmed", "cancelled", "manual_review"].includes(record.pendingReservationCancellationFlow.status),
  );
}

export async function startReservationChangeFlow(input: {
  conversation: ConversationRecord;
  message: string;
  replyPlan: ConversationReplyPlan;
  kind: ChangeKind;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<ReservationChangeFlowOutcome> {
  const now = input.deps?.now?.() ?? new Date();
  if (input.conversation.clientStatus === "blocked" || input.conversation.clientStatus === "ambiguous") {
    return {
      conversation: {
        ...input.conversation,
        mode: "human",
        humanRequested: true,
        requiresManualReview: true,
        updatedAt: nowIso(now),
      },
      reply: "Disculpa, para modificar esta reserva necesitamos que el equipo lo revise. Te contestarán por aquí para confirmarlo.",
      eventType: "reservation_change_manual_review",
      eventPayload: { reason: "client_directory_guardrail", kind: input.kind },
      handoff: true,
    };
  }

  const records = await listReservationRecords(input.deps);
  const resolved = resolveReservations({
    conversation: input.conversation,
    records,
    message: input.message,
    replyPlan: input.replyPlan,
    now,
  });

  if (input.kind === "cancellation") {
    if (resolved.kind === "single") {
      const reservation = resolved.reservations[0];
      const flow: PendingReservationCancellationFlow = {
        ...flowBase(input.conversation, now),
        status: "awaiting_confirmation",
        targetReservationId: reservation.reservationId,
        petName: reservation.petName,
        checkInDate: reservation.checkInDate,
        checkInTime: reservation.checkInTime,
        checkOutDate: reservation.checkOutDate,
        checkOutTime: reservation.checkOutTime,
      };
      return {
        conversation: applyCancellationFlow(input.conversation, flow),
        reply: buildSelectedCancellationReply(reservation),
        eventType: "reservation_cancellation_flow_started",
        eventPayload: { status: flow.status, targetReservationId: safeReservationRef(flow.targetReservationId) },
      };
    }
    const flow: PendingReservationCancellationFlow = {
      ...flowBase(input.conversation, now),
      status: "identifying_reservation",
      candidateReservationIds: resolved.reservations.map((reservation) => reservation.reservationId),
    };
    return {
      conversation: applyCancellationFlow(input.conversation, flow),
      reply: resolved.kind === "multiple"
        ? buildMultipleReply("cancellation", resolved.reservations)
        : buildNoReservationReply("cancellation"),
      eventType: "reservation_cancellation_flow_started",
      eventPayload: { status: flow.status, matchCount: resolved.reservations.length },
    };
  }

  if (resolved.kind === "single") {
    const reservation = resolved.reservations[0];
    const flow: PendingReservationModificationFlow = {
      ...flowBase(input.conversation, now),
      status: "collecting_change",
      targetReservationId: reservation.reservationId,
      petName: reservation.petName,
      currentCheckInDate: reservation.checkInDate,
      currentCheckInTime: reservation.checkInTime,
      currentCheckOutDate: reservation.checkOutDate,
      currentCheckOutTime: reservation.checkOutTime,
      oldPrice: reservation.pricing?.total,
    };
    return {
      conversation: applyModificationFlow(input.conversation, flow),
      reply: buildSelectedModificationReply(reservation),
      eventType: "reservation_modification_flow_started",
      eventPayload: { status: flow.status, targetReservationId: safeReservationRef(flow.targetReservationId) },
    };
  }

  const flow: PendingReservationModificationFlow = {
    ...flowBase(input.conversation, now),
    status: "identifying_reservation",
    candidateReservationIds: resolved.reservations.map((reservation) => reservation.reservationId),
  };
  return {
    conversation: applyModificationFlow(input.conversation, flow),
    reply: resolved.kind === "multiple"
      ? buildMultipleReply("modification", resolved.reservations)
      : buildNoReservationReply("modification"),
    eventType: "reservation_modification_flow_started",
    eventPayload: { status: flow.status, matchCount: resolved.reservations.length },
  };
}

async function findTarget(input: {
  conversation: ConversationRecord;
  flow: PendingReservationModificationFlow | PendingReservationCancellationFlow;
  message: string;
  replyPlan: ConversationReplyPlan;
  deps?: WhatsAppReservationBridgeDeps;
  now: Date;
}): Promise<TargetResolution> {
  const records = await listReservationRecords(input.deps);
  if (input.flow.targetReservationId) {
    const target = records.find((record) => record.reservationId === input.flow.targetReservationId);
    return target ? { kind: "single", reservations: [target] } : { kind: "none", reservations: [] };
  }
  return resolveReservations({
    conversation: input.conversation,
    records,
    message: input.message,
    replyPlan: input.replyPlan,
    now: input.now,
  });
}

async function proposeModification(input: {
  conversation: ConversationRecord;
  flow: PendingReservationModificationFlow;
  reservation: ReservationRecord;
  message: string;
  deps?: WhatsAppReservationBridgeDeps;
  now: Date;
}): Promise<ReservationChangeFlowOutcome> {
  const dateRange = parseDateRange(input.message, input.now);
  const times = parseTimes(input.message);
  const normalized = normalize(input.message);
  const requestedNotes =
    !dateRange && /(?:observacion|observaciones|medicacion|alimentacion|datos)/.test(normalized)
      ? input.message.trim().slice(0, 500)
      : undefined;

  if (!dateRange && !times.checkInTime && !times.checkOutTime && !requestedNotes) {
    return {
      conversation: applyModificationFlow(input.conversation, {
        ...input.flow,
        status: "collecting_change",
        updatedAt: nowIso(input.now),
      }),
      reply: `Seguimos con la modificación de ${input.reservation.petName ?? "tu mascota"}. Dime las nuevas fechas u horas, por ejemplo “del 27 al 29 de diciembre”, o qué observación quieres cambiar.`,
      eventType: "reservation_modification_details_requested",
      eventPayload: { targetReservationId: safeReservationRef(input.reservation.reservationId) },
    };
  }

  const requestedCheckInDate = dateRange?.checkIn ?? input.reservation.checkInDate;
  const requestedCheckOutDate = dateRange?.checkOut ?? input.reservation.checkOutDate;
  const requestedCheckInTime = times.checkInTime ?? input.reservation.checkInTime;
  const requestedCheckOutTime = times.checkOutTime ?? input.reservation.checkOutTime;
  const requestedChanges: PendingReservationModificationFlow["requestedChanges"] = [];
  if (dateRange) requestedChanges.push("dates");
  if (times.checkInTime || times.checkOutTime) requestedChanges.push("times");
  if (requestedNotes) requestedChanges.push("notes");

  let availabilityStatus: PendingReservationModificationFlow["availabilityStatus"] = "available";
  let newPrice = input.reservation.pricing?.total;
  if (dateRange || times.checkInTime || times.checkOutTime) {
    const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultBuildSheetAdapter())();
    const availability = await adapter.checkAvailability({
      entryDate: requestedCheckInDate,
      entrySlot: input.reservation.checkInSlot,
      exitDate: requestedCheckOutDate,
      exitSlot: input.reservation.checkOutSlot,
      dogs: input.reservation.petCount,
    });
    if (!availability.available) {
      const nextFlow: PendingReservationModificationFlow = {
        ...input.flow,
        status: "collecting_change",
        requestedCheckInDate,
        requestedCheckOutDate,
        requestedCheckInTime,
        requestedCheckOutTime,
        requestedChanges,
        availabilityStatus: "unavailable",
        updatedAt: nowIso(input.now),
      };
      return {
        conversation: applyModificationFlow(input.conversation, nextFlow),
        reply: "Para esas nuevas fechas no tenemos disponibilidad. ¿Quieres probar con otras fechas?",
        eventType: "reservation_modification_availability_unavailable",
        eventPayload: { conflictCount: availability.conflicts.length },
      };
    }
    availabilityStatus = "available";
    newPrice = quoteReservation({
      checkInDate: requestedCheckInDate,
      checkOutDate: requestedCheckOutDate,
      petCount: input.reservation.petCount,
    }).total;
  }

  const nextFlow: PendingReservationModificationFlow = {
    ...input.flow,
    status: "awaiting_confirmation",
    targetReservationId: input.reservation.reservationId,
    petName: input.reservation.petName,
    currentCheckInDate: input.reservation.checkInDate,
    currentCheckInTime: input.reservation.checkInTime,
    currentCheckOutDate: input.reservation.checkOutDate,
    currentCheckOutTime: input.reservation.checkOutTime,
    requestedCheckInDate,
    requestedCheckInTime,
    requestedCheckOutDate,
    requestedCheckOutTime,
    requestedChanges,
    requestedNotes,
    availabilityStatus,
    oldPrice: input.reservation.pricing?.total,
    newPrice,
    priceDelta:
      newPrice !== undefined && input.reservation.pricing?.total !== undefined
        ? newPrice - input.reservation.pricing.total
        : undefined,
    updatedAt: nowIso(input.now),
  };

  const priceLine = newPrice !== undefined ? ` El nuevo precio sería de ${newPrice} €.` : "";
  return {
    conversation: applyModificationFlow(input.conversation, nextFlow),
    reply: `Tenemos disponibilidad para cambiar la reserva de ${input.reservation.petName ?? "tu mascota"} al ${formatDate(requestedCheckInDate)} hasta ${formatDate(requestedCheckOutDate)}.${priceLine} ¿Confirmas el cambio?`,
    eventType: "reservation_modification_proposed",
    eventPayload: {
      targetReservationId: safeReservationRef(input.reservation.reservationId),
      requestedChanges,
      availabilityStatus,
      newPrice,
    },
  };
}

async function confirmModification(input: {
  conversation: ConversationRecord;
  flow: PendingReservationModificationFlow;
  reservation: ReservationRecord;
  deps?: WhatsAppReservationBridgeDeps;
  now: Date;
}): Promise<ReservationChangeFlowOutcome> {
  const requestedCheckInDate = input.flow.requestedCheckInDate ?? input.reservation.checkInDate;
  const requestedCheckOutDate = input.flow.requestedCheckOutDate ?? input.reservation.checkOutDate;
  const hasSheetChange =
    requestedCheckInDate !== input.reservation.checkInDate ||
    requestedCheckOutDate !== input.reservation.checkOutDate ||
    input.flow.requestedCheckInTime !== input.reservation.checkInTime ||
    input.flow.requestedCheckOutTime !== input.reservation.checkOutTime;

  const now = nowIso(input.now);
  let availability: Awaited<ReturnType<SheetAdapter["checkAvailability"]>> | undefined;
  let writeResult: SheetsWriteResult | undefined;
  try {
    const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultBuildSheetAdapter())();
    if (hasSheetChange) {
      availability = await adapter.checkAvailability({
        entryDate: requestedCheckInDate,
        entrySlot: input.reservation.checkInSlot,
        exitDate: requestedCheckOutDate,
        exitSlot: input.reservation.checkOutSlot,
        dogs: input.reservation.petCount,
      });
      if (!availability.available) {
        const nextFlow: PendingReservationModificationFlow = {
          ...input.flow,
          status: "collecting_change",
          availabilityStatus: "unavailable",
          updatedAt: now,
        };
        return {
          conversation: applyModificationFlow(input.conversation, nextFlow),
          reply: "Acabo de volver a comprobar disponibilidad y no puedo confirmar ese cambio automáticamente. ¿Quieres probar con otras fechas?",
          eventType: "reservation_modification_revalidation_unavailable",
          eventPayload: { conflictCount: availability.conflicts.length },
        };
      }

      await adapter.cancelReservation(input.reservation.reservationId);
      const preview = updatedReservationFromModification({
        reservation: input.reservation,
        flow: input.flow,
        availability,
        nowIso: now,
      });
      writeResult = await adapter.writeReservation(toLegacyReservationRecord(preview, "confirmada"));
    }

    const updated = updatedReservationFromModification({
      reservation: input.reservation,
      flow: input.flow,
      writeResult,
      availability,
      nowIso: now,
    });
    await (input.deps?.upsertReservationRecord ?? upsertReservation)(updated);
    const nextFlow: PendingReservationModificationFlow = {
      ...input.flow,
      status: "confirmed",
      updatedAt: now,
    };
    return {
      conversation: {
        ...applyModificationFlow(input.conversation, nextFlow),
        reservationId: updated.reservationId,
        sourceRecordId: updated.reservationId,
        petName: updated.petName ?? input.conversation.petName,
      },
      reply: `Cambio confirmado. Tu reserva para ${updated.petName ?? "tu mascota"} queda actualizada: entrada ${formatDate(updated.checkInDate)}${updated.checkInTime ? ` a las ${updated.checkInTime}` : ""} y salida ${formatDate(updated.checkOutDate)}${updated.checkOutTime ? ` a las ${updated.checkOutTime}` : ""}. Si necesitas cualquier otra cosa, escríbenos por aquí.`,
      eventType: "reservation_modified_from_whatsapp",
      eventPayload: {
        targetReservationId: safeReservationRef(updated.reservationId),
        sheetWrite: hasSheetChange ? "updated" : "not_needed",
        entryLogWrite: "projected_from_reservation_record",
      },
    };
  } catch (error) {
    const nextFlow: PendingReservationModificationFlow = {
      ...input.flow,
      status: "manual_review",
      failureReason: error instanceof Error ? error.name : "unknown_error",
      updatedAt: now,
    };
    return {
      conversation: {
        ...applyModificationFlow(input.conversation, nextFlow),
        mode: "human",
        humanRequested: true,
        requiresManualReview: true,
      },
      reply: "Disculpa, para modificar esta reserva necesitamos que el equipo lo revise. Te contestarán por aquí para confirmarlo.",
      eventType: "reservation_modification_failed",
      eventPayload: { reason: nextFlow.failureReason },
      handoff: true,
    };
  }
}

async function confirmCancellation(input: {
  conversation: ConversationRecord;
  flow: PendingReservationCancellationFlow;
  reservation: ReservationRecord;
  deps?: WhatsAppReservationBridgeDeps;
  now: Date;
}): Promise<ReservationChangeFlowOutcome> {
  const now = nowIso(input.now);
  try {
    const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultBuildSheetAdapter())();
    const cancellation = await adapter.cancelReservation(input.reservation.reservationId);
    const cancelled = updatedReservationFromCancellation(
      input.reservation,
      cancellation.cancelledAt ?? now,
    );
    await (input.deps?.upsertReservationRecord ?? upsertReservation)(cancelled);
    const nextFlow: PendingReservationCancellationFlow = {
      ...input.flow,
      status: "confirmed",
      updatedAt: now,
    };
    return {
      conversation: {
        ...applyCancellationFlow(input.conversation, nextFlow),
        reservationId: cancelled.reservationId,
        sourceRecordId: cancelled.reservationId,
        petName: cancelled.petName ?? input.conversation.petName,
      },
      reply: `Reserva cancelada. Hemos dejado anotada la cancelación de la reserva de ${cancelled.petName ?? "tu mascota"}. Si necesitas hacer una nueva reserva más adelante, escríbenos por aquí.`,
      eventType: "reservation_cancelled_from_whatsapp",
      eventPayload: {
        targetReservationId: safeReservationRef(cancelled.reservationId),
        clearedCells: cancellation.clearedCells.length,
        entryLogWrite: "projected_from_reservation_record",
      },
    };
  } catch (error) {
    const nextFlow: PendingReservationCancellationFlow = {
      ...input.flow,
      status: "manual_review",
      failureReason: error instanceof Error ? error.name : "unknown_error",
      updatedAt: now,
    };
    return {
      conversation: {
        ...applyCancellationFlow(input.conversation, nextFlow),
        mode: "human",
        humanRequested: true,
        requiresManualReview: true,
      },
      reply: "Disculpa, para cancelar esta reserva necesitamos que el equipo lo revise. Te contestarán por aquí para confirmarlo.",
      eventType: "reservation_cancellation_failed",
      eventPayload: { reason: nextFlow.failureReason },
      handoff: true,
    };
  }
}

export async function advanceReservationChangeFlow(input: {
  conversation: ConversationRecord;
  message: string;
  replyPlan: ConversationReplyPlan;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<ReservationChangeFlowOutcome | undefined> {
  const now = input.deps?.now?.() ?? new Date();
  const modification = input.conversation.pendingReservationModificationFlow;
  const cancellation = input.conversation.pendingReservationCancellationFlow;

  if (modification && !["confirmed", "cancelled", "manual_review"].includes(modification.status)) {
    if (expired(modification.expiresAt, now)) {
      const expiredFlow = { ...modification, status: "manual_review" as const, failureReason: "expired", updatedAt: nowIso(now) };
      return {
        conversation: applyModificationFlow(input.conversation, expiredFlow),
        reply: "La modificación anterior ya no está vigente. Dime otra vez qué reserva quieres modificar y lo revisamos.",
        eventType: "reservation_modification_expired",
      };
    }
    const target = await findTarget({
      conversation: input.conversation,
      flow: modification,
      message: input.message,
      replyPlan: input.replyPlan,
      deps: input.deps,
      now,
    });
    if (target.kind === "multiple") {
      return {
        conversation: applyModificationFlow(input.conversation, {
          ...modification,
          status: "identifying_reservation",
          candidateReservationIds: target.reservations.map((reservation) => reservation.reservationId),
          updatedAt: nowIso(now),
        }),
        reply: buildMultipleReply("modification", target.reservations),
        eventType: "reservation_modification_multiple_matches",
      };
    }
    if (target.kind === "none") {
      return {
        conversation: applyModificationFlow(input.conversation, {
          ...modification,
          status: "identifying_reservation",
          updatedAt: nowIso(now),
        }),
        reply: buildNoReservationReply("modification"),
        eventType: "reservation_modification_target_missing",
      };
    }

    const reservation = target.reservations[0];
    if (input.replyPlan.source === "faq_public_chat" && input.replyPlan.intent.startsWith("faq_")) {
      const faqReply = renderConversationReplyPlan(input.replyPlan, input.message);
      return {
        conversation: input.conversation,
        reply: `${faqReply}\n\nSeguimos con la modificación: me falta que me indiques el cambio que quieres hacer.`,
        eventType: "reservation_modification_faq_interruption",
        eventPayload: { intent: input.replyPlan.intent },
      };
    }
    if (modification.status === "identifying_reservation") {
      return {
        conversation: applyModificationFlow(input.conversation, {
          ...modification,
          status: "collecting_change",
          targetReservationId: reservation.reservationId,
          petName: reservation.petName,
          currentCheckInDate: reservation.checkInDate,
          currentCheckInTime: reservation.checkInTime,
          currentCheckOutDate: reservation.checkOutDate,
          currentCheckOutTime: reservation.checkOutTime,
          oldPrice: reservation.pricing?.total,
          updatedAt: nowIso(now),
        }),
        reply: buildSelectedModificationReply(reservation),
        eventType: "reservation_modification_target_selected",
      };
    }
    if (modification.status === "awaiting_confirmation") {
      if (isAffirmativeConfirmationUtterance(input.message)) {
        return confirmModification({
          conversation: input.conversation,
          flow: modification,
          reservation,
          deps: input.deps,
          now,
        });
      }
      if (isReservationFlowRejection(input.message)) {
        const cancelledFlow = { ...modification, status: "cancelled" as const, updatedAt: nowIso(now) };
        return {
          conversation: applyModificationFlow(input.conversation, cancelledFlow),
          reply: "De acuerdo, no hacemos ningún cambio. Tu reserva se mantiene como estaba.",
          eventType: "reservation_modification_rejected",
        };
      }
    }
    return proposeModification({
      conversation: input.conversation,
      flow: {
        ...modification,
        targetReservationId: reservation.reservationId,
        petName: reservation.petName,
      },
      reservation,
      message: input.message,
      deps: input.deps,
      now,
    });
  }

  if (cancellation && !["confirmed", "cancelled", "manual_review"].includes(cancellation.status)) {
    if (expired(cancellation.expiresAt, now)) {
      const expiredFlow = { ...cancellation, status: "manual_review" as const, failureReason: "expired", updatedAt: nowIso(now) };
      return {
        conversation: applyCancellationFlow(input.conversation, expiredFlow),
        reply: "La cancelación anterior ya no está vigente. Dime otra vez qué reserva quieres cancelar y lo revisamos.",
        eventType: "reservation_cancellation_expired",
      };
    }
    const target = await findTarget({
      conversation: input.conversation,
      flow: cancellation,
      message: input.message,
      replyPlan: input.replyPlan,
      deps: input.deps,
      now,
    });
    if (target.kind === "multiple") {
      return {
        conversation: applyCancellationFlow(input.conversation, {
          ...cancellation,
          status: "identifying_reservation",
          candidateReservationIds: target.reservations.map((reservation) => reservation.reservationId),
          updatedAt: nowIso(now),
        }),
        reply: buildMultipleReply("cancellation", target.reservations),
        eventType: "reservation_cancellation_multiple_matches",
      };
    }
    if (target.kind === "none") {
      return {
        conversation: applyCancellationFlow(input.conversation, {
          ...cancellation,
          status: "identifying_reservation",
          updatedAt: nowIso(now),
        }),
        reply: buildNoReservationReply("cancellation"),
        eventType: "reservation_cancellation_target_missing",
      };
    }
    const reservation = target.reservations[0];
    if (input.replyPlan.source === "faq_public_chat" && input.replyPlan.intent.startsWith("faq_")) {
      const faqReply = renderConversationReplyPlan(input.replyPlan, input.message);
      return {
        conversation: input.conversation,
        reply: `${faqReply}\n\nSeguimos con la cancelación: dime si confirmas cancelar esa reserva.`,
        eventType: "reservation_cancellation_faq_interruption",
        eventPayload: { intent: input.replyPlan.intent },
      };
    }
    if (cancellation.status === "identifying_reservation") {
      return {
        conversation: applyCancellationFlow(input.conversation, {
          ...cancellation,
          status: "awaiting_confirmation",
          targetReservationId: reservation.reservationId,
          petName: reservation.petName,
          checkInDate: reservation.checkInDate,
          checkInTime: reservation.checkInTime,
          checkOutDate: reservation.checkOutDate,
          checkOutTime: reservation.checkOutTime,
          updatedAt: nowIso(now),
        }),
        reply: buildSelectedCancellationReply(reservation),
        eventType: "reservation_cancellation_target_selected",
      };
    }
    if (isAffirmativeConfirmationUtterance(input.message)) {
      return confirmCancellation({
        conversation: input.conversation,
        flow: cancellation,
        reservation,
        deps: input.deps,
        now,
      });
    }
    if (isReservationFlowRejection(input.message)) {
      const cancelledFlow = { ...cancellation, status: "cancelled" as const, updatedAt: nowIso(now) };
      return {
        conversation: applyCancellationFlow(input.conversation, cancelledFlow),
        reply: "De acuerdo, mantenemos la reserva como estaba.",
        eventType: "reservation_cancellation_rejected",
      };
    }
    return {
      conversation: applyCancellationFlow(input.conversation, {
        ...cancellation,
        status: "awaiting_confirmation",
        targetReservationId: reservation.reservationId,
        updatedAt: nowIso(now),
      }),
      reply: buildSelectedCancellationReply(reservation),
      eventType: "reservation_cancellation_confirmation_requested",
    };
  }

  return undefined;
}

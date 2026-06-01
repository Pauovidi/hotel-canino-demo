import { randomUUID } from "node:crypto";
import { ClientDirectoryService, normalizeEmail, type ClientDirectory } from "@/lib/hotel/clients";
import { getHotelFeatureFlags, getHotelRuntimeConfig } from "@/lib/hotel/config";
import type { PricingQuote as DomainPricingQuote } from "@/lib/hotel/domain/contracts";
import type { HotelSlot } from "@/lib/hotel/domain/slots";
import { quoteStayPrice } from "@/lib/hotel/pricing/engine";
import type { PricingQuote } from "@/lib/hotel/pricing/types";
import { buildGoogleSheetAdapter, buildMockSheetAdapter } from "@/lib/hotel/sheets";
import type { WhatsAppReservationBridgeDeps } from "./reservation-bridge";
import type {
  ConversationRecord,
  ConversationReservationFlow,
  PendingReservationProposal,
} from "./types";

const RESERVATION_FLOW_TTL_MS = 2 * 60 * 60 * 1000;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

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

const ENTRY_MARKER_PATTERN =
  /\b(?:entrada|entra(?:ria|mos|n)?|entraria|dejo|dejamos|llevaria|llegada)\b/;
const EXIT_MARKER_PATTERN =
  /\b(?:salida|sale(?:n)?|sal(?:dria|imos|go)?|saldria|recojo|recogeria|recogida)\b/;
const FALSE_PET_PREFIX_PATTERN =
  /^(?:entrada|salida|entra|entramos|entran|entraria|salimos|sale|salen|saldria|dejo|dejamos|llevaria|recojo|recogeria|llegada|recogida|del|desde|hasta|a las?|por la manana|por la tarde)\b/;
const PET_DETAIL_STOP_PATTERN =
  /\b(?:entrada|salida|entra|entramos|entran|entraria|salimos|sale|salen|saldria|dejo|dejamos|llevaria|recojo|recogeria|llegada|recogida|del|desde|hasta|a\s+las?|por\s+la\s+manana|por\s+la\s+tarde)\b.*$/iu;

export interface ReservationFlowOutcome {
  conversation: ConversationRecord;
  reply: string;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDateTimeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,;()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function isYes(message: string): boolean {
  const normalized = normalizeText(message);
  return /^(s+i+|soy cliente|ya soy cliente|cliente habitual|si soy cliente|si ya soy cliente)\b/.test(normalized);
}

function isNo(message: string): boolean {
  const normalized = normalizeText(message);
  return /^(no|no soy cliente|primera vez|es la primera vez|nuevo|soy nuevo)\b/.test(normalized);
}

export function isReservationFlowRejection(message: string): boolean {
  const normalized = normalizeText(message);
  return /^(no|no gracias|mejor no|no confirmo|cancelar|cancela|dejalo|déjalo)$/.test(normalized);
}

export function isReservationFlowActive(conversation: ConversationRecord): boolean {
  const status = conversation.reservationFlow?.status;
  return Boolean(
    status &&
      !["confirmed", "rejected", "no_availability"].includes(status),
  );
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

  return date.toISOString().slice(0, 10);
}

function normalizeYear(rawYear: string | undefined, now: Date, month: number, day: number): number {
  if (rawYear) {
    const numeric = Number.parseInt(rawYear, 10);
    return numeric < 100 ? 2000 + numeric : numeric;
  }

  const year = now.getUTCFullYear();
  const today = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
  const candidate = Date.UTC(year, month - 1, day);
  return candidate >= today ? year : year + 1;
}

function parseNumericDate(value: string, now: Date): string | undefined {
  const match = value.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!match) {
    return undefined;
  }

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = normalizeYear(match[3], now, month, day);
  return isoDate(year, month, day);
}

function parseTime(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const normalized = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\bmanana\b/.test(normalized)) {
    return "mañana";
  }
  if (/\btarde\b/.test(normalized)) {
    return "tarde";
  }

  const match = normalized.match(/\b(\d{1,2})(?:(?::|\.)\s*(\d{2})|h(?:\s*(\d{2}))?)?\b/);
  if (!match) {
    return undefined;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = match[2] || match[3] ? Number.parseInt(match[2] ?? match[3], 10) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function slotFromTime(time: string | undefined): HotelSlot | undefined {
  if (!time) {
    return undefined;
  }

  const normalized = normalizeText(time);
  if (normalized.includes("manana")) {
    return "morning";
  }
  if (normalized.includes("tarde")) {
    return "afternoon";
  }

  const hour = Number.parseInt(time.slice(0, 2), 10);
  return hour < 14 ? "morning" : "afternoon";
}

function findDateInText(
  value: string,
  now: Date,
  fallbackMonth?: number,
): { date?: string; month?: number; endIndex?: number } {
  const numeric = value.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numeric?.index !== undefined) {
    const day = Number.parseInt(numeric[1], 10);
    const month = Number.parseInt(numeric[2], 10);
    const year = normalizeYear(numeric[3], now, month, day);
    return {
      date: isoDate(year, month, day),
      month,
      endIndex: numeric.index + numeric[0].length,
    };
  }

  const natural = value.match(/\b(?:el\s+)?(\d{1,2})(?:\s+de\s+([a-z]+))?(?:\s+de\s+(\d{2,4}))?\b/);
  if (!natural || natural.index === undefined) {
    return {};
  }

  const month = MONTHS[natural[2] ?? ""] ?? fallbackMonth;
  if (!month) {
    return {};
  }

  const day = Number.parseInt(natural[1], 10);
  const year = normalizeYear(natural[3], now, month, day);
  return {
    date: isoDate(year, month, day),
    month,
    endIndex: natural.index + natural[0].length,
  };
}

function findTimeInText(value: string): string | undefined {
  const labeled = value.match(
    /\b(?:a\s+las?|a\s+la|sobre\s+las?|hacia\s+las?|por\s+la\s+)(manana|tarde|\d{1,2}(?:(?::|\.)\d{2})?h?)\b/,
  );
  const compactTime = labeled?.[1] ?? value.match(/\b(manana|tarde|\d{1,2}(?:(?::|\.)\d{2})?h?)\b/)?.[1];
  return parseTime(compactTime);
}

function parseDateTimeSegment(
  segment: string,
  now: Date,
  fallbackMonth?: number,
): { date?: string; time?: string; month?: number } {
  const dateMatch = findDateInText(segment, now, fallbackMonth);
  const timeSource = dateMatch.endIndex !== undefined ? segment.slice(dateMatch.endIndex) : segment;
  return {
    date: dateMatch.date,
    time: findTimeInText(timeSource),
    month: dateMatch.month,
  };
}

function applyExplicitEntryExitDateTimes(
  result: Partial<ConversationReservationFlow>,
  normalized: string,
  now: Date,
) {
  const entryMarker = normalized.match(ENTRY_MARKER_PATTERN);
  const exitMarker = normalized.match(EXIT_MARKER_PATTERN);
  if (entryMarker?.index === undefined || exitMarker?.index === undefined) {
    return;
  }

  const entryBeforeExit = entryMarker.index < exitMarker.index;
  const firstMarker = entryBeforeExit ? entryMarker : exitMarker;
  const secondMarker = entryBeforeExit ? exitMarker : entryMarker;
  const firstSegment = normalized.slice(firstMarker.index, secondMarker.index);
  const secondSegment = normalized.slice(secondMarker.index);
  const first = parseDateTimeSegment(firstSegment, now);
  const second = parseDateTimeSegment(secondSegment, now, first.month);

  const entry = entryBeforeExit ? first : second;
  const exit = entryBeforeExit ? second : first;

  result.checkInDate ??= entry.date;
  result.checkInTime ??= entry.time;
  result.checkOutDate ??= exit.date;
  result.checkOutTime ??= exit.time;
}

function parseDatesAndTimes(message: string, now: Date): Partial<ConversationReservationFlow> {
  const normalized = normalizeDateTimeText(message);
  const result: Partial<ConversationReservationFlow> = {};
  applyExplicitEntryExitDateTimes(result, normalized, now);
  const slashRange = normalized.match(
    /entra\w*\D+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\D+?(?:a\s+las?\s+|por\s+la\s+)?(\d{1,2}(?::\d{2})?|manana|tarde).*?sal\w*\D+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\D+?(?:a\s+las?\s+|por\s+la\s+)?(\d{1,2}(?::\d{2})?|manana|tarde)/,
  );

  if (slashRange && !result.checkInDate) {
    result.checkInDate = parseNumericDate(slashRange[1], now);
    result.checkInTime = parseTime(slashRange[2]);
    result.checkOutDate = parseNumericDate(slashRange[3], now);
    result.checkOutTime = parseTime(slashRange[4]);
  }

  const monthRangeWithTimes = normalized.match(
    /\b(?:del|desde)\s+(\d{1,2})(?:\s+de\s+([a-z]+))?(?:\s+a\s+las?\s+|\s+por\s+la\s+)(\d{1,2}(?::\d{2})?|manana|tarde)\s+(?:al|hasta)\s+(\d{1,2})(?:\s+de\s+([a-z]+))?(?:\s+de\s+(\d{4}))?(?:\s+a\s+las?\s+|\s+por\s+la\s+)(\d{1,2}(?::\d{2})?|manana|tarde)\b/,
  );

  if (monthRangeWithTimes) {
    const month = MONTHS[monthRangeWithTimes[2] || monthRangeWithTimes[5] || ""];
    if (month) {
      const startDay = Number.parseInt(monthRangeWithTimes[1], 10);
      const endDay = Number.parseInt(monthRangeWithTimes[4], 10);
      const year = normalizeYear(monthRangeWithTimes[6], now, month, startDay);
      result.checkInDate = isoDate(year, month, startDay);
      result.checkOutDate = isoDate(year, month, endDay);
      result.checkInTime = parseTime(monthRangeWithTimes[3]);
      result.checkOutTime = parseTime(monthRangeWithTimes[7]);
    }
  }

  const monthRange = normalized.match(
    /\b(?:del|desde)\s+(\d{1,2})(?:\s+de\s+([a-z]+))?\s+(?:al|hasta)\s+(\d{1,2})(?:\s+de\s+([a-z]+))?(?:\s+de\s+(\d{4}))?\b/,
  );

  if (monthRange && !result.checkInDate) {
    const month = MONTHS[monthRange[2] || monthRange[4] || ""];
    if (month) {
      const startDay = Number.parseInt(monthRange[1], 10);
      const endDay = Number.parseInt(monthRange[3], 10);
      const year = normalizeYear(monthRange[5], now, month, startDay);
      result.checkInDate = isoDate(year, month, startDay);
      result.checkOutDate = isoDate(year, month, endDay);
    }
  }

  const entryTime =
    normalized.match(/\bentrad[ao]?\s+(?:a\s+las?\s+|por\s+la\s+)(\d{1,2}(?:(?::|\.)\d{2})?h?|manana|tarde)\b/)?.[1] ??
    normalized.match(/\bentra(?:ria|ria)?\s+(?:a\s+las?\s+|por\s+la\s+)(\d{1,2}(?:(?::|\.)\d{2})?h?|manana|tarde)\b/)?.[1];
  const exitTime =
    normalized.match(/\bsalid[ao]?\s+(?:a\s+las?\s+|por\s+la\s+)(\d{1,2}(?:(?::|\.)\d{2})?h?|manana|tarde)\b/)?.[1] ??
    normalized.match(/\bsaldria\s+(?:a\s+las?\s+|por\s+la\s+)(\d{1,2}(?:(?::|\.)\d{2})?h?|manana|tarde)\b/)?.[1];

  result.checkInTime ??= parseTime(entryTime);
  result.checkOutTime ??= parseTime(exitTime);
  result.checkInSlot = slotFromTime(result.checkInTime);
  result.checkOutSlot = slotFromTime(result.checkOutTime);

  return result;
}

function extractEmail(message: string): string | undefined {
  return normalizeEmail(message.match(EMAIL_PATTERN)?.[0] ?? "") ?? undefined;
}

function extractOwnerName(message: string): string | undefined {
  const withoutEmail = message.replace(EMAIL_PATTERN, "");
  const match = withoutEmail.match(/\b(?:me llamo|soy|nombre\s*:?)\s+([\p{L}' -]{3,80})/iu);
  const candidate = compact(match?.[1] ?? withoutEmail)
    .replace(/\b(mi|email|correo|es)\b/gi, "")
    .trim();
  return candidate.split(/\s+/).length >= 2 ? candidate : undefined;
}

function extractPetName(message: string): string | undefined {
  const match =
    message.match(/\b(?:mascota|perro|perra)\s+(?:se llama|es)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})\b/iu) ??
    message.match(/\bnombre\s+de\s+(?:mi\s+)?(?:mascota|perro|perra)\s+(?:es|:)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})\b/iu) ??
    message.match(/\bse\s+llama\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})\b/iu) ??
    message.match(/\b(?:para|reservar para)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2})\b/iu) ??
    message.match(/^([\p{L}'-]{2,24}(?:\s+[\p{L}'-]{2,24}){0,1})(?:,|\s+y|\s+\d|\s*$)/iu);
  if (!match?.[1]) {
    return undefined;
  }

  const candidate = compact(match[1].replace(PET_DETAIL_STOP_PATTERN, ""));
  if (!candidate || FALSE_PET_PREFIX_PATTERN.test(normalizeText(candidate))) {
    return undefined;
  }

  return candidate;
}

function extractPetCount(message: string): number | undefined {
  const normalized = normalizeText(message);
  if (/\b(4|cuatro)\s+perr/.test(normalized)) return 4;
  if (/\b(3|tres)\s+perr/.test(normalized)) return 3;
  if (/\b(2|dos)\s+perr/.test(normalized)) return 2;
  if (/\b(1|un|una)\s+perr/.test(normalized)) return 1;
  const numeric = normalized.match(/\b(\d)\b/);
  return numeric ? Math.max(1, Math.min(4, Number.parseInt(numeric[1], 10))) : undefined;
}

function extractNotes(message: string): Partial<ConversationReservationFlow> {
  const normalized = normalizeText(message);
  if (/^(no|ninguna|sin medicacion|sin medicacion especial|sin notas)/.test(normalized)) {
    return { notes: "Sin notas adicionales" };
  }

  return {
    foodNotes: /pienso|come|comida|alimentacion/.test(normalized) ? compact(message) : undefined,
    medicationNotes: /medic|tratamiento|necesidad|especial/.test(normalized) ? compact(message) : undefined,
    notes: compact(message),
  };
}

function extractVisit(message: string): boolean | null | undefined {
  if (isYes(message)) return true;
  if (isNo(message)) return false;
  return undefined;
}

function hasMinimumClient(flow: ConversationReservationFlow): boolean {
  return flow.clientKind === "habitual"
    ? Boolean(flow.email)
    : Boolean(flow.ownerName && flow.email);
}

function hasStayData(flow: ConversationReservationFlow): boolean {
  return Boolean(
    flow.petName &&
      flow.petCount &&
      flow.checkInDate &&
      flow.checkInTime &&
      flow.checkInSlot &&
      flow.checkOutDate &&
      flow.checkOutTime &&
      flow.checkOutSlot,
  );
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
      "Precio calculado por noches; la hora se conserva como dato operativo y no cambia el precio.",
    ],
  };
}

function quoteNights(flow: ConversationReservationFlow): DomainPricingQuote {
  const pricing = quoteStayPrice(
    {
      stay: {
        checkIn: { date: flow.checkInDate!, slot: "afternoon" },
        checkOut: { date: flow.checkOutDate!, slot: "morning" },
      },
      dogs: flow.petCount!,
    },
    buildPricingConfig(),
  );
  return toDomainPricing(pricing);
}

function getDefaultBuildSheetAdapter() {
  return getHotelFeatureFlags().useGoogleSheetsReal
    ? buildGoogleSheetAdapter
    : () => buildMockSheetAdapter("hotel-whatsapp-reservation-flow.json");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function proposalReply(flow: ConversationReservationFlow): string {
  return `Tenemos disponibilidad para ${flow.petName} del ${formatDate(flow.checkInDate!)} a las ${flow.checkInTime} al ${formatDate(flow.checkOutDate!)} a las ${flow.checkOutTime}. El precio sería de ${flow.price} €. ¿Confirmas la reserva?`;
}

function nextCollectionReply(flow: ConversationReservationFlow): string {
  if (flow.status === "asking_client_kind") {
    return "Perfecto. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.";
  }
  if (flow.status === "asking_existing_email") {
    return "Genial. Para localizar tu ficha, dime el email con el que sueles reservar.";
  }
  if (flow.status === "collecting_owner") {
    return "Perfecto. Te tomo los datos para la reserva. Primero dime tu nombre y apellidos y tu email.";
  }
  if (flow.status === "collecting_pet") {
    return "Perfecto. Dime el nombre de tu mascota y cuántos perros son.";
  }
  if (flow.status === "collecting_dates") {
    if (flow.checkInDate && flow.checkOutDate && (!flow.checkInTime || !flow.checkOutTime)) {
      return "Perfecto. ¿A qué hora sería la entrada y a qué hora sería la salida?";
    }
    if ((!flow.checkInDate || !flow.checkOutDate) && (flow.checkInTime || flow.checkOutTime)) {
      return "Gracias. ¿Qué fecha de entrada y qué fecha de salida serían?";
    }
    return "Gracias. Dime la fecha y hora de entrada, y la fecha y hora de salida.";
  }
  if (flow.status === "collecting_notes") {
    return "Anotado. ¿Hay alimentación, medicación o alguna observación importante?";
  }
  if (flow.status === "collecting_visit") {
    return "¿Quieres visitar el hotel antes de confirmar?";
  }
  return "Perfecto. Sigo con la reserva.";
}

function syncConversationFromFlow(conversation: ConversationRecord, flow: ConversationReservationFlow): ConversationRecord {
  return {
    ...conversation,
    customerName: flow.ownerName ?? conversation.customerName,
    clientEmail: flow.email ?? conversation.clientEmail,
    petName: flow.petName ?? conversation.petName,
    reservationFlow: flow,
    updatedAt: flow.updatedAt,
  };
}

function updateStage(flow: ConversationReservationFlow): ConversationReservationFlow {
  if (flow.status === "asking_client_kind") return flow;
  if (flow.clientKind === "habitual" && !flow.email) {
    return { ...flow, status: "asking_existing_email" };
  }
  if (flow.clientKind === "new" && !hasMinimumClient(flow)) {
    return { ...flow, status: "collecting_owner" };
  }
  if (!flow.petName || !flow.petCount) {
    return { ...flow, status: "collecting_pet" };
  }
  if (!hasStayData(flow)) {
    return { ...flow, status: "collecting_dates" };
  }
  if (!flow.notes && !flow.foodNotes && !flow.medicationNotes) {
    return { ...flow, status: "collecting_notes" };
  }
  if (flow.wantsVisit === undefined) {
    return { ...flow, status: "collecting_visit" };
  }
  return { ...flow, status: "pending_availability", availabilityStatus: "pending" };
}

async function buildAvailableProposal(input: {
  conversation: ConversationRecord;
  flow: ConversationReservationFlow;
  inboundMessageId: string;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<{ flow: ConversationReservationFlow; proposal?: PendingReservationProposal; reply: string; eventPayload: Record<string, unknown> }> {
  const adapter = await (input.deps?.buildSheetAdapter ?? getDefaultBuildSheetAdapter())();
  const availability = await adapter.checkAvailability({
    entryDate: input.flow.checkInDate!,
    entrySlot: input.flow.checkInSlot!,
    exitDate: input.flow.checkOutDate!,
    exitSlot: input.flow.checkOutSlot!,
    dogs: input.flow.petCount!,
  });

  if (!availability.available) {
    return {
      flow: {
        ...input.flow,
        status: "no_availability",
        availabilityStatus: "unavailable",
        updatedAt: nowIso(input.deps?.now?.() ?? new Date()),
      },
      reply: "Lo siento, para esas fechas no tenemos disponibilidad. ¿Quieres probar con otras fechas?",
      eventPayload: { availability: "unavailable", conflictCount: availability.conflicts.length },
    };
  }

  const pricing = quoteNights(input.flow);
  const proposalId = `proposal_${randomUUID()}`;
  const now = input.deps?.now?.() ?? new Date();
  const nextFlow: ConversationReservationFlow = {
    ...input.flow,
    status: "pending_confirmation",
    availabilityStatus: "available",
    price: pricing.total,
    priceSource: "calculated",
    priceNeedsReview: false,
    proposalId,
    updatedAt: nowIso(now),
  };
  const proposal: PendingReservationProposal = {
    proposalId,
    conversationId: input.conversation.id,
    phoneNormalized: input.conversation.phoneNormalized,
    clientStatus: input.conversation.clientStatus ?? "unknown",
    clientName: input.conversation.clientName ?? nextFlow.ownerName,
    ownerName: nextFlow.ownerName,
    ownerEmail: nextFlow.email,
    petName: nextFlow.petName!,
    checkIn: nextFlow.checkInDate!,
    checkOut: nextFlow.checkOutDate!,
    checkInSlot: nextFlow.checkInSlot!,
    checkOutSlot: nextFlow.checkOutSlot!,
    checkInTime: nextFlow.checkInTime,
    checkOutTime: nextFlow.checkOutTime,
    petCount: nextFlow.petCount!,
    price: pricing.total,
    priceSource: "calculated",
    priceNeedsReview: false,
    pricing,
    wantsVisit: nextFlow.wantsVisit,
    foodNotes: nextFlow.foodNotes,
    medicationNotes: nextFlow.medicationNotes,
    notes: nextFlow.notes,
    requestedAt: nowIso(now),
    expiresAt: new Date(now.getTime() + RESERVATION_FLOW_TTL_MS).toISOString(),
    availabilitySnapshot: {
      monthKey: availability.monthKey,
      available: true,
      conflictCount: 0,
    },
    status: "proposed",
    source: "whatsapp",
    createdFromMessageId: input.inboundMessageId,
  };

  return {
    flow: nextFlow,
    proposal,
    reply: proposalReply(nextFlow),
    eventPayload: {
      availability: "available",
      price: pricing.total,
      priceSource: "calculated",
      proposalId,
    },
  };
}

export function startReservationFlow(input: {
  conversation: ConversationRecord;
  inboundMessageId: string;
  now?: Date;
}): ReservationFlowOutcome {
  const now = input.now ?? new Date();
  const flow: ConversationReservationFlow = {
    flowId: `reservation_flow_${randomUUID()}`,
    status: "asking_client_kind",
    clientKind: "unknown",
    availabilityStatus: "pending",
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };

  return {
    conversation: syncConversationFromFlow(input.conversation, flow),
    reply: nextCollectionReply(flow),
    eventType: "reservation_flow_started",
    eventPayload: { status: flow.status },
  };
}

export async function advanceReservationFlow(input: {
  conversation: ConversationRecord;
  inboundMessageId: string;
  message: string;
  clientDirectory: ClientDirectory;
  deps?: WhatsAppReservationBridgeDeps;
}): Promise<ReservationFlowOutcome | undefined> {
  const current = input.conversation.reservationFlow;
  if (!current || !isReservationFlowActive(input.conversation)) {
    return undefined;
  }

  const now = input.deps?.now?.() ?? new Date();
  let flow: ConversationReservationFlow = { ...current, updatedAt: nowIso(now) };

  if (flow.status === "asking_client_kind") {
    if (isYes(input.message)) {
      flow = { ...flow, clientKind: "habitual", status: "asking_existing_email" };
    } else if (isNo(input.message)) {
      flow = { ...flow, clientKind: "new", status: "collecting_owner" };
    } else {
      return {
        conversation: syncConversationFromFlow(input.conversation, flow),
        reply: "Perfecto. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.",
        eventType: "reservation_flow_waiting_client_kind",
      };
    }
  } else if (flow.status === "asking_existing_email") {
    const email = extractEmail(input.message);
    if (!email) {
      return {
        conversation: syncConversationFromFlow(input.conversation, flow),
        reply: "Necesito un email válido para localizar tu ficha de cliente.",
        eventType: "reservation_flow_email_invalid",
      };
    }

    const identity = await new ClientDirectoryService(input.clientDirectory).findClientByEmail(email);
    if (identity.status === "blocked" || identity.status === "ambiguous") {
      flow = { ...flow, email, status: "asking_existing_email" };
      return {
        conversation: syncConversationFromFlow(
          {
            ...input.conversation,
            clientStatus: identity.status,
            clientConfidence: identity.confidence,
            clientMatchType: identity.matchType,
            clientEmail: email,
            clientWarnings: identity.warnings,
            requiresManualReview: true,
            mode: "human",
            humanRequested: true,
          },
          flow,
        ),
        reply: "Gracias, revisamos tu solicitud con el equipo y te contestamos por aquí.",
        eventType:
          identity.status === "blocked"
            ? "reservation_flow_existing_client_blocked"
            : "reservation_flow_existing_client_ambiguous",
        eventPayload: { status: identity.status, matchType: identity.matchType },
      };
    }

    if (identity.status === "known") {
      const client = identity.client;
      flow = {
        ...flow,
        clientKind: "habitual",
        email,
        ownerName: client?.nombre ?? flow.ownerName,
        status: "collecting_pet",
      };
      const conversation = syncConversationFromFlow(
        {
          ...input.conversation,
          clientStatus: "known",
          clientConfidence: "strong",
          clientMatchType: "email",
          clientName: client?.nombre,
          clientEmail: email,
          clientSource: identity.source,
          clientSheetName: client?.sheetName,
          clientSheetRow: client?.rowNumber,
          tags: Array.from(new Set([...(input.conversation.tags ?? []), "cliente_habitual"])),
        },
        flow,
      );
      return {
        conversation,
        reply: "Perfecto. Dime el nombre de tu mascota, cuántos perros son, la fecha y hora de entrada, y la fecha y hora de salida.",
        eventType: "reservation_flow_existing_client_email_match",
        eventPayload: { matchType: "email", status: "known" },
      };
    }

    flow = {
      ...flow,
      clientKind: "new",
      email,
      status: "collecting_owner",
    };
    return {
      conversation: syncConversationFromFlow(
        {
          ...input.conversation,
          clientStatus: "unknown",
          clientConfidence: "none",
          clientMatchType: "none",
          clientEmail: email,
          clientName: undefined,
          clientSource: undefined,
        },
        flow,
      ),
      reply: "No encuentro ese email en la ficha de clientes. Puedo tomar tus datos como nuevo contacto para esta reserva. Dime tu nombre y apellidos.",
      eventType: "reservation_flow_existing_client_email_not_found",
      eventPayload: { status: identity.status, matchType: identity.matchType },
    };
  }

  if (flow.status === "collecting_owner") {
    flow = {
      ...flow,
      email: extractEmail(input.message) ?? flow.email,
      ownerName: extractOwnerName(input.message) ?? flow.ownerName,
    };
  }

  if (flow.status === "collecting_pet") {
    flow = {
      ...flow,
      petName: extractPetName(input.message) ?? flow.petName,
      petCount: extractPetCount(input.message) ?? flow.petCount,
    };
  }

  if (flow.status === "collecting_dates") {
    flow = { ...flow, ...defined(parseDatesAndTimes(input.message, now)) };
  }

  if (flow.status === "collecting_notes") {
    flow = { ...flow, ...extractNotes(input.message) };
  }

  if (flow.status === "collecting_visit") {
    const wantsVisit = extractVisit(input.message);
    if (wantsVisit !== undefined) {
      flow = { ...flow, wantsVisit };
    } else {
      flow = { ...flow, wantsVisit: null };
    }
  }

  // Opportunistically extract details from richer answers once the client branch is known.
  const canReadReservationDetails =
    current.status === "collecting_pet" || current.status === "collecting_dates";
  flow = {
    ...flow,
    email: extractEmail(input.message) ?? flow.email,
    petName: canReadReservationDetails ? extractPetName(input.message) ?? flow.petName : flow.petName,
    petCount: canReadReservationDetails ? extractPetCount(input.message) ?? flow.petCount : flow.petCount,
    ...(canReadReservationDetails ? defined(parseDatesAndTimes(input.message, now)) : {}),
  };

  flow = updateStage(flow);

  if (flow.status === "pending_availability") {
    const availability = await buildAvailableProposal({
      conversation: input.conversation,
      flow,
      inboundMessageId: input.inboundMessageId,
      deps: input.deps,
    });
    const visitPrefix =
      current.status === "collecting_visit" && flow.wantsVisit === true
        ? "Perfecto. Las visitas se coordinan de lunes a jueves de 10:00 a 18:00. Lo dejamos anotado para el equipo. "
        : current.status === "collecting_visit" && flow.wantsVisit === false
          ? "Perfecto, seguimos con la reserva. "
          : "";
    return {
      conversation: {
        ...syncConversationFromFlow(input.conversation, availability.flow),
        pendingReservationProposal: availability.proposal ?? input.conversation.pendingReservationProposal,
      },
      reply: `${visitPrefix}${availability.reply}`,
      eventType: "reservation_flow_availability_checked",
      eventPayload: availability.eventPayload,
    };
  }

  const conversation = syncConversationFromFlow(input.conversation, flow);
  const visitPrefix =
    current.status === "collecting_visit" && flow.wantsVisit === true
      ? "Perfecto. Las visitas se coordinan de lunes a jueves de 10:00 a 18:00. Lo dejamos anotado para el equipo. "
      : current.status === "collecting_visit" && flow.wantsVisit === false
        ? "Perfecto, seguimos con la reserva. "
        : "";

  return {
    conversation,
    reply: `${visitPrefix}${nextCollectionReply(flow)}`,
    eventType: "reservation_flow_updated",
    eventPayload: {
      status: flow.status,
      clientKind: flow.clientKind,
      hasEmail: Boolean(flow.email),
      hasStayData: hasStayData(flow),
    },
  };
}

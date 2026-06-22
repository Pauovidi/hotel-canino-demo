import { randomUUID } from "node:crypto";
import {
  ClientDirectoryService,
  normalizeEmail,
  type ClientDirectory,
  type ClientRecord,
} from "@/lib/hotel/clients";
import { getHotelFeatureFlags, getHotelRuntimeConfig } from "@/lib/hotel/config";
import type { PricingQuote as DomainPricingQuote } from "@/lib/hotel/domain/contracts";
import { HOTEL_SLOT_WINDOWS, type HotelSlot } from "@/lib/hotel/domain/slots";
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
const DEFAULT_MORNING_TIME = HOTEL_SLOT_WINDOWS.morning.start;
const DEFAULT_AFTERNOON_TIME = HOTEL_SLOT_WINDOWS.afternoon.start;
const TIME_PREFERENCE_PROMPT =
  "Sin problema. ¿Prefieres mañana o tarde? Si te da igual, puedo poner la primera hora de la mañana o la primera de la tarde.";
const TIME_CONTEXT_FALLBACK =
  "Para poder calcular disponibilidad y precio necesito la hora de entrada y la hora de salida. Si te da igual, puedo proponerte primera hora de la mañana o primera hora de la tarde.";
const PET_NAMES_PROMPT = "Genial. Dime el nombre o los nombres de tu mascota/s.";
const CLIENT_RECORD_FOUND_REPLY =
  "He encontrado una ficha con este teléfono, así que seguimos con tu reserva.";

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
  /^(?:(?:pues\s+)?(?:el\s+)?\d{1,2}(?:\s+de\s+[a-z]+|[/-]\d{1,2}|\s+a\s+las?)|(?:pues\s+)?(?:entrada|salida|entra|entramos|entran|entraria|salimos|sale|salen|saldria|dejo|dejamos|llevaria|recojo|recogeria|llegada|recogida|del|desde|hasta|a las?|por la manana|por la tarde)\b)/;
const PET_DETAIL_STOP_PATTERN =
  /\b(?:entrada|salida|entra|entramos|entran|entraria|salimos|sale|salen|saldria|dejo|dejamos|llevaria|recojo|recogeria|llegada|recogida|del|desde|hasta|quiero|a\s+las?|por\s+la\s+manana|por\s+la\s+tarde)\b.*$/iu;

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

export function isExplicitNotClientClaim(message: string): boolean {
  const normalized = normalizeText(message);
  return /^(no soy cliente|no,?\s*soy cliente|primera vez|es la primera vez|soy nuevo|soy nueva)\b/.test(
    normalized,
  );
}

function isRecognizedDirectoryClient(conversation: ConversationRecord): boolean {
  return (
    conversation.clientStatus === "known" &&
    conversation.clientConfidence === "strong" &&
    (conversation.clientMatchType === "phone" || conversation.clientMatchType === "email")
  );
}

function clientDisplayName(conversation: ConversationRecord): string | undefined {
  return conversation.clientName ?? conversation.customerName;
}

function firstName(value?: string): string | undefined {
  return value?.trim().split(/\s+/)[0];
}

function knownClientIntro(conversation: ConversationRecord): string {
  const name = firstName(clientDisplayName(conversation));
  return name ? `Genial, ${name}. Te localizo en nuestra ficha.` : "Genial. Te localizo en nuestra ficha.";
}

function knownClientPetPrompt(conversation: ConversationRecord): string {
  return `${knownClientIntro(conversation)} Dime el nombre de tu mascota o mascotas y las fechas de la reserva.`;
}

function safeClientPets(input: {
  pets?: string[];
  count?: number;
  status?:
    | "exact"
    | "exact_or_token"
    | "token_subset_unique"
    | "probable_high_unique_token"
    | "exact_canonical"
    | "token_subset_unique_canonical"
    | "probable_high_unique_token_canonical"
    | "duplicate_clear_canonical"
    | "ambiguous_canonical"
    | "ambiguous"
    | "missing"
    | "manual_review";
}): string[] {
  const pets = Array.isArray(input.pets)
    ? input.pets.map((pet) => pet.trim()).filter(Boolean)
    : [];

  const safeStatus =
    input.status === "exact" ||
    input.status === "exact_or_token" ||
    input.status === "token_subset_unique" ||
    input.status === "probable_high_unique_token" ||
    input.status === "exact_canonical" ||
    input.status === "token_subset_unique_canonical" ||
    input.status === "probable_high_unique_token_canonical" ||
    input.status === "duplicate_clear_canonical";
  if (!safeStatus || pets.length === 0) {
    return [];
  }

  if (input.count !== undefined && input.count !== pets.length) {
    return [];
  }

  return pets;
}

function safeKnownClientPets(conversation: ConversationRecord): string[] {
  return safeClientPets({
    pets: conversation.clientPets,
    count: conversation.clientPetsCount,
    status: conversation.clientPetsMatchStatus,
  });
}

function safeClientRecordPets(client?: ClientRecord): string[] {
  return safeClientPets({
    pets: client?.mascotas,
    count: client?.mascotasCount,
    status: client?.mascotasMatchStatus,
  });
}

function formatPetList(pets: string[]): string {
  if (pets.length <= 1) {
    return pets[0] ?? "";
  }

  return `${pets.slice(0, -1).join(", ")} y ${pets.at(-1)}`;
}

function knownClientPetAwarePrompt(conversation: ConversationRecord): string {
  const pets = safeKnownClientPets(conversation);
  const name = firstName(clientDisplayName(conversation));
  const intro = name ? `Genial, ${name}.` : "Genial.";

  if (pets.length === 1) {
    return `${intro} Tengo registrada a ${pets[0]}. ¿Qué fechas necesitas para la reserva?`;
  }

  if (pets.length > 1) {
    return `${intro} Tengo registradas a ${formatPetList(pets)}. ¿La reserva sería para alguna de ellas o para otra mascota?`;
  }

  return knownClientPetPrompt(conversation);
}

function knownClientEmailPrompt(conversation: ConversationRecord): string {
  return `${knownClientIntro(conversation)} Antes de seguir, ¿me confirmas el email que quieres asociar a esta reserva?`;
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
  if (!/\d/.test(normalized) && /\bmanana\b/.test(normalized)) {
    return "mañana";
  }
  if (!/\d/.test(normalized) && /\btarde\b/.test(normalized)) {
    return "tarde";
  }

  const match = normalized.match(
    /\b(\d{1,2})(?:(?::|\.)\s*(\d{2})|h(?:\s*(\d{2}))?)?(?:\s*(am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(manana|tarde|noche))?\b/,
  );
  if (!match) {
    return undefined;
  }

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] || match[3] ? Number.parseInt(match[2] ?? match[3], 10) : 0;
  const meridiem = match[4]?.replace(/\s+/g, "");
  const dayPart = match[5];
  if ((meridiem === "pm" || dayPart === "tarde" || dayPart === "noche") && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
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
    /\b(?:a\s+las?|a\s+la|sobre\s+las?|hacia\s+las?|por\s+la\s+)(manana|tarde|\d{1,2}(?:(?::|\.)\d{2})?h?(?:\s*(?:am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(?:manana|tarde|noche))?)\b/,
  );
  const compactTime = labeled?.[1] ?? value.match(/\b(manana|tarde|\d{1,2}(?:(?::|\.)\d{2})?h?(?:\s*(?:am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(?:manana|tarde|noche))?)\b/)?.[1];
  return parseTime(compactTime);
}

function extractLabeledTimeMentions(value: string): string[] {
  const mentions: string[] = [];
  const matcher =
    /\b(?:a\s+las?|a\s+la|sobre\s+las?|sobre|hacia\s+las?|hacia|por\s+la|las?)\s+(manana|tarde|\d{1,2}(?:(?::|\.)\d{2})?h?(?:\s*(?:am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(?:manana|tarde|noche))?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const parsed = parseTime(match[1]);
    if (parsed) {
      mentions.push(parsed);
    }
  }
  return mentions;
}

function defaultTimeForSlot(slot: HotelSlot): string {
  return slot === "morning" ? DEFAULT_MORNING_TIME : DEFAULT_AFTERNOON_TIME;
}

function hasDatesAndNeedsTimes(flow: ConversationReservationFlow): boolean {
  return Boolean(flow.checkInDate && flow.checkOutDate && (!flow.checkInTime || !flow.checkOutTime));
}

function isIndifferentTimePreference(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(?:la hora me da igual|me da igual|me es indiferente|lo que vosotros me digais|lo que me digais|lo que digais|cuando mejor os venga|cuando os vaya bien|me adapto|cualquiera|la que sea|poned vosotros|como querais|lo que querais)\b/.test(normalized);
}

function isMorningPreference(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(manana|por la manana|mejor manana|primera hora de la manana)\b/.test(normalized);
}

function isAfternoonPreference(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(tarde|por la tarde|mejor tarde|primera hora de la tarde)\b/.test(normalized);
}

function minutesFromTime(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function isOutsideReceptionDay(time: string): boolean {
  const value = minutesFromTime(time);
  return (
    value < minutesFromTime(HOTEL_SLOT_WINDOWS.morning.start) ||
    value > minutesFromTime(HOTEL_SLOT_WINDOWS.afternoon.end)
  );
}

function buildTimeOutOfRangeReply(times: string[]): string {
  const unique = Array.from(new Set(times));
  const understood = unique.length === 1 ? unique[0] : unique.join(" y ");
  return `He entendido ${understood}, pero puede quedar fuera del horario habitual. ¿Quieres que lo dejemos en primera hora de la mañana o primera hora de la tarde?`;
}

function buildMissingMonthReply(): string {
  return "Entiendo los días, pero necesito el mes para revisar disponibilidad. ¿De qué mes sería?";
}

function extractLooseTimeMentions(message: string): string[] {
  const normalized = normalizeDateTimeText(message);
  const mentions: string[] = [];
  const matcher =
    /\b(?:a\s+las?\s+)?(\d{1,2})(?:(?::|\.)\s*(\d{2}))?(?:\s*(am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(manana|tarde|noche))?\b/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(normalized)) !== null) {
    const [raw] = match;
    const parsed = parseTime(raw);
    if (parsed) {
      mentions.push(parsed);
    }
  }
  return mentions;
}

function buildTimePatch(
  checkInTime: string,
  checkOutTime: string,
): Partial<ConversationReservationFlow> {
  return {
    checkInTime,
    checkInSlot: slotFromTime(checkInTime),
    checkOutTime,
    checkOutSlot: slotFromTime(checkOutTime),
    timePreferencePrompted: undefined,
  };
}

function extractSharedEntryExitTime(message: string): string | undefined {
  const normalized = normalizeDateTimeText(message);
  if (
    !/\b(?:entrada\s+y\s+salida|salida\s+y\s+entrada|las\s+dos|ambas|ambos)\b/.test(
      normalized,
    )
  ) {
    return undefined;
  }

  const explicit =
    normalized.match(/\b(?:a\s+las?|a\s+la|sobre\s+las?|hacia\s+las?|las?)\s+(\d{1,2}(?:(?::|\.)\d{2})?h?(?:\s*(?:am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(?:manana|tarde|noche))?)\b/)?.[1] ??
    normalized.match(/\b(\d{1,2}(?:(?::|\.)\d{2})?h?(?:\s*(?:am|pm|a\s*m|p\s*m))?(?:\s+de\s+la\s+(?:manana|tarde|noche))?)\b/)?.[1];

  return parseTime(explicit);
}

function resolveAwaitingTimeInput(
  flow: ConversationReservationFlow,
  message: string,
): { patch?: Partial<ConversationReservationFlow>; reply?: string; eventType?: string; eventPayload?: Record<string, unknown> } | undefined {
  if (!hasDatesAndNeedsTimes(flow)) {
    return undefined;
  }

  const morning = isMorningPreference(message);
  const afternoon = isAfternoonPreference(message);
  const indifferent = isIndifferentTimePreference(message);

  if (indifferent && !flow.timePreferencePrompted) {
    return {
      patch: { timePreferencePrompted: true },
      reply: TIME_PREFERENCE_PROMPT,
      eventType: "reservation_flow_waiting_time_preference",
      eventPayload: { awaiting: "check_in_out_times", preference: "indifferent_prompted" },
    };
  }

  if (indifferent && flow.timePreferencePrompted) {
    return {
      patch: buildTimePatch(DEFAULT_MORNING_TIME, DEFAULT_AFTERNOON_TIME),
      eventPayload: { preference: "indifferent_defaults", checkInTime: DEFAULT_MORNING_TIME, checkOutTime: DEFAULT_AFTERNOON_TIME },
    };
  }

  const explicit = parseDatesAndTimes(message, new Date());
  if (explicit.checkInTime && explicit.checkOutTime) {
    const outOfRange = [explicit.checkInTime, explicit.checkOutTime].filter(isOutsideReceptionDay);
    if (outOfRange.length > 0) {
      return {
        patch: { timePreferencePrompted: true },
        reply: buildTimeOutOfRangeReply(outOfRange),
        eventType: "reservation_flow_time_out_of_range",
        eventPayload: { outOfRangeTimes: outOfRange },
      };
    }
    return {
      patch: {
        checkInTime: explicit.checkInTime,
        checkInSlot: explicit.checkInSlot,
        checkOutTime: explicit.checkOutTime,
        checkOutSlot: explicit.checkOutSlot,
        timePreferencePrompted: undefined,
      },
      eventPayload: { source: "explicit_entry_exit_times" },
    };
  }

  const sharedTime = extractSharedEntryExitTime(message);
  if (sharedTime) {
    const outOfRange = [sharedTime].filter(isOutsideReceptionDay);
    if (outOfRange.length > 0) {
      return {
        patch: { timePreferencePrompted: true },
        reply: buildTimeOutOfRangeReply(outOfRange),
        eventType: "reservation_flow_time_out_of_range",
        eventPayload: { outOfRangeTimes: outOfRange },
      };
    }
    return {
      patch: buildTimePatch(sharedTime, sharedTime),
      eventPayload: { source: "shared_entry_exit_time", checkInTime: sharedTime, checkOutTime: sharedTime },
    };
  }

  if (explicit.checkInTime && !explicit.checkOutTime) {
    const outOfRange = [explicit.checkInTime].filter(isOutsideReceptionDay);
    if (outOfRange.length > 0) {
      return {
        patch: { timePreferencePrompted: true },
        reply: buildTimeOutOfRangeReply(outOfRange),
        eventType: "reservation_flow_time_out_of_range",
        eventPayload: { outOfRangeTimes: outOfRange },
      };
    }
    return {
      patch: {
        checkInTime: explicit.checkInTime,
        checkInSlot: explicit.checkInSlot,
        timePreferencePrompted: undefined,
      },
      eventPayload: { source: "explicit_entry_time", checkInTime: explicit.checkInTime },
    };
  }

  if (explicit.checkOutTime && !explicit.checkInTime) {
    const outOfRange = [explicit.checkOutTime].filter(isOutsideReceptionDay);
    if (outOfRange.length > 0) {
      return {
        patch: { timePreferencePrompted: true },
        reply: buildTimeOutOfRangeReply(outOfRange),
        eventType: "reservation_flow_time_out_of_range",
        eventPayload: { outOfRangeTimes: outOfRange },
      };
    }
    return {
      patch: {
        checkOutTime: explicit.checkOutTime,
        checkOutSlot: explicit.checkOutSlot,
        timePreferencePrompted: undefined,
      },
      eventPayload: { source: "explicit_exit_time", checkOutTime: explicit.checkOutTime },
    };
  }

  const looseTimes = extractLooseTimeMentions(message);
  if (looseTimes.length >= 2) {
    const [checkInTime, checkOutTime] = looseTimes;
    const outOfRange = [checkInTime, checkOutTime].filter(isOutsideReceptionDay);
    if (outOfRange.length > 0) {
      return {
        patch: { timePreferencePrompted: true },
        reply: buildTimeOutOfRangeReply(outOfRange),
        eventType: "reservation_flow_time_out_of_range",
        eventPayload: { outOfRangeTimes: outOfRange },
      };
    }
    return {
      patch: buildTimePatch(checkInTime, checkOutTime),
      eventPayload: { source: "loose_time_pair", checkInTime, checkOutTime },
    };
  }

  if (looseTimes.length === 1) {
    return {
      patch: { timePreferencePrompted: true },
      reply: `¿Ponemos las ${looseTimes[0]} tanto para la entrada como para la salida?`,
      eventType: "reservation_flow_waiting_shared_time_confirmation",
      eventPayload: { time: looseTimes[0] },
    };
  }

  if (morning && afternoon) {
    return {
      patch: buildTimePatch(DEFAULT_MORNING_TIME, DEFAULT_AFTERNOON_TIME),
      eventPayload: { preference: "morning_afternoon", checkInTime: DEFAULT_MORNING_TIME, checkOutTime: DEFAULT_AFTERNOON_TIME },
    };
  }

  if (morning || afternoon) {
    const slot: HotelSlot = morning ? "morning" : "afternoon";
    const time = defaultTimeForSlot(slot);
    return {
      patch: buildTimePatch(time, time),
      eventPayload: { preference: slot, checkInTime: time, checkOutTime: time },
    };
  }

  return undefined;
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

function buildDateRange(
  input: {
    startDay: number;
    startMonth: number;
    startYear?: string;
    endDay: number;
    endMonth?: number;
    endYear?: string;
  },
  now: Date,
): { checkInDate?: string; checkOutDate?: string } {
  const endMonth = input.endMonth ?? input.startMonth;
  const startYear = normalizeYear(input.startYear ?? input.endYear, now, input.startMonth, input.startDay);
  let endYear = input.endYear ? normalizeYear(input.endYear, now, endMonth, input.endDay) : startYear;
  if (Date.UTC(endYear, endMonth - 1, input.endDay) < Date.UTC(startYear, input.startMonth - 1, input.startDay)) {
    endYear += 1;
  }

  return {
    checkInDate: isoDate(startYear, input.startMonth, input.startDay),
    checkOutDate: isoDate(endYear, endMonth, input.endDay),
  };
}

function applyOrderedDateTimePairs(
  result: Partial<ConversationReservationFlow>,
  normalized: string,
  now: Date,
): { missingMonth?: boolean } {
  const numericTime =
    "(\\d{1,2}(?:(?::|\\.)\\d{2})?h?(?:\\s*(?:am|pm|a\\s*m|p\\s*m))?(?:\\s+de\\s+la\\s+(?:manana|tarde|noche))?|manana|tarde)";
  const timePrefix = "(?:a\\s+las?|a\\s+la|sobre\\s+las?|sobre|hacia\\s+las?|hacia|las?)\\s+";

  const numericPair = normalized.match(
    new RegExp(
      `\\b(\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)\\s+(?:${timePrefix})?${numericTime}\\s+y\\s+(\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)\\s+(?:${timePrefix})?${numericTime}\\b`,
    ),
  );
  if (numericPair) {
    result.checkInDate ??= parseNumericDate(numericPair[1], now);
    result.checkInTime ??= parseTime(numericPair[2]);
    result.checkOutDate ??= parseNumericDate(numericPair[3], now);
    result.checkOutTime ??= parseTime(numericPair[4]);
    return {};
  }

  const naturalPair = normalized.match(
    new RegExp(
      `\\b(?:pues\\s+)?(?:el\\s+)?(\\d{1,2})(?:\\s+de\\s+([a-z]+))?(?:\\s+de\\s+(\\d{2,4}))?\\s+${timePrefix}${numericTime}\\s+y\\s+(?:el\\s+)?(\\d{1,2})(?:\\s+de\\s+([a-z]+))?(?:\\s+de\\s+(\\d{2,4}))?\\s+${timePrefix}${numericTime}\\b`,
    ),
  );
  if (naturalPair) {
    const startMonth = MONTHS[naturalPair[2] ?? ""];
    const endMonth = MONTHS[naturalPair[6] ?? ""];
    const month = startMonth ?? endMonth;
    if (!month) {
      return { missingMonth: true };
    }

    const range = buildDateRange(
      {
        startDay: Number.parseInt(naturalPair[1], 10),
        startMonth: startMonth ?? month,
        startYear: naturalPair[3] ?? naturalPair[7],
        endDay: Number.parseInt(naturalPair[5], 10),
        endMonth: endMonth ?? month,
        endYear: naturalPair[7] ?? naturalPair[3],
      },
      now,
    );
    result.checkInDate ??= range.checkInDate;
    result.checkInTime ??= parseTime(naturalPair[4]);
    result.checkOutDate ??= range.checkOutDate;
    result.checkOutTime ??= parseTime(naturalPair[8]);
    return {};
  }

  return {};
}

function needsMonthForDateTimeInput(message: string): boolean {
  const normalized = normalizeDateTimeText(message);
  if (Object.keys(MONTHS).some((month) => normalized.includes(month)) || /\d{1,2}[/-]\d{1,2}/.test(normalized)) {
    return false;
  }

  const numericTime =
    "\\d{1,2}(?:(?::|\\.)\\d{2})?h?(?:\\s*(?:am|pm|a\\s*m|p\\s*m))?(?:\\s+de\\s+la\\s+(?:manana|tarde|noche))?";
  const timePrefix = "(?:a\\s+las?|a\\s+la|sobre\\s+las?|sobre|hacia\\s+las?|hacia|las?)\\s+";
  return new RegExp(
    `\\b(?:pues\\s+)?(?:el\\s+)?\\d{1,2}\\s+${timePrefix}${numericTime}\\s+y\\s+(?:el\\s+)?\\d{1,2}\\s+${timePrefix}${numericTime}\\b`,
  ).test(normalized);
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
  applyOrderedDateTimePairs(result, normalized, now);
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

  if (result.checkInDate && result.checkOutDate && (!result.checkInTime || !result.checkOutTime)) {
    const labeledTimes = extractLabeledTimeMentions(normalized);
    if (labeledTimes.length >= 2) {
      result.checkInTime ??= labeledTimes[0];
      result.checkOutTime ??= labeledTimes[1];
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
    .replace(/[.,;:]+$/g, "")
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

function countWordToNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeText(value);
  const map: Record<string, number> = {
    "1": 1,
    un: 1,
    uno: 1,
    una: 1,
    "2": 2,
    dos: 2,
    "3": 3,
    tres: 3,
    "4": 4,
    cuatro: 4,
    "5": 5,
    cinco: 5,
    "6": 6,
    seis: 6,
  };
  return map[normalized];
}

function extractStatedPetCount(message: string): number | undefined {
  const normalized = normalizeText(message);
  const countToken = "(\\d|un|uno|una|dos|tres|cuatro|cinco|seis)";
  const direct =
    normalized.match(new RegExp(`\\b(?:tengo|serian|son)\\s+${countToken}\\s+perr`))?.[1] ??
    normalized.match(new RegExp(`\\b${countToken}\\s+perr`))?.[1] ??
    normalized.match(new RegExp(`\\bson\\s+${countToken}\\b`))?.[1] ??
    normalized.match(new RegExp(`^${countToken}$`))?.[1];
  return countWordToNumber(direct);
}

function isUnknownPetNames(message: string): boolean {
  const normalized = normalizeText(message);
  return /^(no lo se|no lo se aun|no lo se todavia|aun no lo se|todavia no lo se)$/.test(normalized);
}

function extractExplicitPetCorrection(message: string): string | undefined {
  const value = compact(message);
  const normalized = normalizeText(value);
  if (/^(?:manana|tarde|me da igual|las dos|ambas|cualquiera|la que sea)\b/.test(normalized)) {
    return undefined;
  }

  const match = value.match(/^(?:ser[ií]a\s+para|es\s+para|para|se\s+llama|es)\s+(.+)$/iu);
  const candidate = compact(match?.[1]?.replace(PET_DETAIL_STOP_PATTERN, "") ?? "");
  return candidate || undefined;
}

function formatPetNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return `${names[0]} y ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

function namesQuestion(count: number): string {
  if (count === 1) {
    return "Gracias. ¿Cómo se llama la mascota?";
  }
  if (count === 2) {
    return "Gracias. ¿Cómo se llaman las dos mascotas?";
  }
  return `Gracias. ¿Cómo se llaman las ${count} mascotas?`;
}

function cleanPetNamesCandidate(value: string): string {
  return compact(value)
    .replace(PET_DETAIL_STOP_PATTERN, "")
    .replace(/\b(?:son|serian|serían)\s+(?:\d|un|uno|una|dos|tres|cuatro|cinco|seis)\s*$/iu, "")
    .replace(/,\s*(?:son|serian|serían)\s+(?:\d|un|uno|una|dos|tres|cuatro|cinco|seis)\s*$/iu, "")
    .replace(/\b(?:\d|un|uno|una|dos|tres|cuatro|cinco|seis)\s+perros?\b/iu, "")
    .replace(/\b(?:y|e)\s*$/iu, "")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim();
}

function splitPetNames(candidate: string): string[] {
  return candidate
    .split(/\s*(?:,|\s+y\s+|\s+e\s+)\s*/iu)
    .map((name) => compact(name))
    .map((name) => name.replace(/^(?:son|se llaman|se llama)\s+/iu, "").trim())
    .filter((name) => Boolean(name) && /[\p{L}]/u.test(name))
    .filter((name) => !/^(?:perro|perros|mascota|mascotas|tengo|mis|mi|se|llama|llaman)$/iu.test(name));
}

function extractPetNames(message: string): string[] {
  const normalized = normalizeText(message);
  if (FALSE_PET_PREFIX_PATTERN.test(normalized)) {
    return [];
  }

  const countToken = "(?:\\d|un|uno|una|dos|tres|cuatro|cinco|seis)";
  const patterns = [
    new RegExp(`\\btengo\\s+${countToken}\\s+perros?\\s*,\\s*(.+)$`, "iu"),
    /\bmis\s+mascotas?\s+se\s+llaman?\s+(.+)$/iu,
    /\bmi\s+mascota\s+se\s+llama\s+(.+)$/iu,
    /\bnombre\s+de\s+(?:mi\s+)?(?:mascota|perro|perra)\s+(?:es|:)\s+(.+)$/iu,
    /\bmis\s+perros?\s+son\s+(.+)$/iu,
    /^son\s+(.+)$/iu,
  ];
  const match = patterns.map((pattern) => message.match(pattern)?.[1]).find(Boolean);
  const hasOnlyCount = Boolean(extractStatedPetCount(message)) && !message.includes(",") && !/\s+y\s+/iu.test(message);
  const rawCandidate = match ?? (hasOnlyCount ? undefined : message);
  if (!rawCandidate) {
    return [];
  }

  const candidate = cleanPetNamesCandidate(rawCandidate);
  if (!candidate || FALSE_PET_PREFIX_PATTERN.test(normalizeText(candidate))) {
    return [];
  }

  return splitPetNames(candidate);
}

function extractPetDetails(message: string): Partial<ConversationReservationFlow> {
  const petNames = extractPetNames(message);
  const nameCount = petNames.length;
  const statedCount = extractStatedPetCount(message);
  const explicitSingularName = extractPetName(message);
  const names = nameCount > 0 ? petNames : explicitSingularName ? [explicitSingularName] : [];

  if (names.length > 1 && statedCount && statedCount !== names.length) {
    return {
      petNames: names,
      petName: formatPetNames(names),
      petCountInconsistency: { nameCount: names.length, statedCount },
    };
  }

  if (names.length > 0) {
    return {
      petNames: names,
      petName: formatPetNames(names),
      petCount: statedCount ?? names.length,
      petCountInference: statedCount ? "names_and_explicit" : "names",
      petCountInconsistency: undefined,
    };
  }

  if (statedCount) {
    return {
      petCount: statedCount,
      petCountInference: "explicit",
    };
  }

  return {};
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
    return "Genial. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.";
  }
  if (flow.status === "asking_existing_email") {
    return "Genial. Para localizar tu ficha, dime el email con el que sueles reservar.";
  }
  if (flow.status === "collecting_owner") {
    return "De acuerdo, te tomo los datos para la reserva. Primero dime tu nombre y apellidos y tu email.";
  }
  if (flow.status === "collecting_pet") {
    if (flow.petCountInconsistency) {
      return `Tengo ${flow.petCountInconsistency.nameCount} nombres pero indicas ${flow.petCountInconsistency.statedCount} perros. ¿Me confirmas los nombres de las ${flow.petCountInconsistency.statedCount} mascotas?`;
    }
    if (flow.petCount && !flow.petName) {
      return namesQuestion(flow.petCount);
    }
    return PET_NAMES_PROMPT;
  }
  if (flow.status === "collecting_dates") {
    if (flow.checkInDate && flow.checkOutDate && flow.checkInTime && !flow.checkOutTime) {
      return "Tengo la hora de entrada. ¿A qué hora sería la salida?";
    }
    if (flow.checkInDate && flow.checkOutDate && flow.checkOutTime && !flow.checkInTime) {
      return "Tengo la hora de salida. ¿A qué hora sería la entrada?";
    }
    if (flow.checkInDate && flow.checkInTime && (!flow.checkOutDate || !flow.checkOutTime)) {
      return "Tengo la entrada. ¿Qué día y a qué hora sería la salida?";
    }
    if (flow.checkOutDate && flow.checkOutTime && (!flow.checkInDate || !flow.checkInTime)) {
      return "Tengo la salida. ¿Qué día y a qué hora sería la entrada?";
    }
    if (flow.checkInDate && flow.checkOutDate && (!flow.checkInTime || !flow.checkOutTime)) {
      return "Ya tengo las fechas. Me falta la hora de entrada y la hora de salida. ¿Me las indicas?";
    }
    if ((!flow.checkInDate || !flow.checkOutDate) && (flow.checkInTime || flow.checkOutTime)) {
      return "Gracias. ¿Qué fecha de entrada y qué fecha de salida serían?";
    }
    return "Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.";
  }
  if (flow.status === "collecting_notes") {
    return "Anotado. ¿Hay alimentación, medicación o alguna observación importante?";
  }
  if (flow.status === "collecting_visit") {
    return "¿Quieres visitar el hotel antes de confirmar?";
  }
  return "Vale. Sigo con la reserva.";
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
  if (!flow.petName || !flow.petCount || Boolean(flow.petCountInconsistency) || flow.petCount > 4) {
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
    petNames: nextFlow.petNames,
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
  const recognizedClient = isRecognizedDirectoryClient(input.conversation);
  const knownPets = recognizedClient ? safeKnownClientPets(input.conversation) : [];
  const singleKnownPet = knownPets.length === 1 ? knownPets[0] : undefined;
  const flow: ConversationReservationFlow = {
    flowId: `reservation_flow_${randomUUID()}`,
    status: recognizedClient
      ? input.conversation.clientEmail
        ? singleKnownPet
          ? "collecting_dates"
          : "collecting_pet"
        : "asking_existing_email"
      : "asking_client_kind",
    clientKind: recognizedClient ? "habitual" : "unknown",
    email: recognizedClient ? input.conversation.clientEmail : undefined,
    ownerName: recognizedClient ? clientDisplayName(input.conversation) : undefined,
    petName: singleKnownPet,
    petNames: singleKnownPet ? [singleKnownPet] : undefined,
    petCount: singleKnownPet ? 1 : undefined,
    availabilityStatus: "pending",
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };

  return {
    conversation: syncConversationFromFlow(input.conversation, flow),
    reply: recognizedClient
      ? input.conversation.clientEmail
        ? knownClientPetAwarePrompt(input.conversation)
        : knownClientEmailPrompt(input.conversation)
      : nextCollectionReply(flow),
    eventType: recognizedClient
      ? "reservation_flow_started_known_client"
      : "reservation_flow_started",
    eventPayload: {
      status: flow.status,
      clientKind: flow.clientKind,
      matchType: input.conversation.clientMatchType,
      needsEmail: recognizedClient && !input.conversation.clientEmail,
      knownPetsCount: knownPets.length,
    },
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
  const recognizedClient = isRecognizedDirectoryClient(input.conversation);

  if (recognizedClient) {
    flow = {
      ...flow,
      clientKind: "habitual",
      ownerName: flow.ownerName ?? clientDisplayName(input.conversation),
      email: flow.email ?? input.conversation.clientEmail,
    };

    if (flow.status === "asking_client_kind") {
      const knownPets = safeKnownClientPets(input.conversation);
      const singleKnownPet = knownPets.length === 1 ? knownPets[0] : undefined;
      const nextFlow: ConversationReservationFlow = {
        ...flow,
        status: input.conversation.clientEmail
          ? singleKnownPet
            ? "collecting_dates"
            : "collecting_pet"
          : "asking_existing_email",
        petName: singleKnownPet ?? flow.petName,
        petNames: singleKnownPet ? [singleKnownPet] : flow.petNames,
        petCount: singleKnownPet ? 1 : flow.petCount,
        updatedAt: nowIso(now),
      };
      const reply = input.conversation.clientEmail
        ? knownClientPetAwarePrompt(input.conversation)
        : knownClientEmailPrompt(input.conversation);
      return {
        conversation: syncConversationFromFlow(input.conversation, nextFlow),
        reply: isExplicitNotClientClaim(input.message)
          ? `${CLIENT_RECORD_FOUND_REPLY} ${reply}`
          : reply,
        eventType: "reservation_flow_known_client_auto_resumed",
        eventPayload: {
          status: nextFlow.status,
          matchType: input.conversation.clientMatchType,
          correctedClientDeclaration: isExplicitNotClientClaim(input.message),
        },
      };
    }
  }

  if (flow.status === "asking_client_kind") {
    if (isYes(input.message)) {
      flow = { ...flow, clientKind: "habitual", status: "asking_existing_email" };
    } else if (isNo(input.message)) {
      flow = { ...flow, clientKind: "new", status: "collecting_owner" };
    } else {
      return {
        conversation: syncConversationFromFlow(input.conversation, flow),
        reply: "Genial. ¿Ya eres cliente de Somos Muy Perros? Responde sí o no.",
        eventType: "reservation_flow_waiting_client_kind",
      };
    }
  } else if (flow.status === "asking_existing_email") {
    if (recognizedClient) {
      const email = extractEmail(input.message);
      if (!email) {
        return {
          conversation: syncConversationFromFlow(input.conversation, flow),
          reply: isExplicitNotClientClaim(input.message)
            ? `${CLIENT_RECORD_FOUND_REPLY} ${knownClientEmailPrompt(input.conversation)}`
            : knownClientEmailPrompt(input.conversation),
          eventType: "reservation_flow_known_client_waiting_email",
          eventPayload: {
            matchType: input.conversation.clientMatchType,
            correctedClientDeclaration: isExplicitNotClientClaim(input.message),
          },
        };
      }

      const normalizedEmail = normalizeEmail(email) ?? email.trim().toLowerCase();
      const existingEmail = normalizeEmail(input.conversation.clientEmail ?? "");
      if (existingEmail && normalizedEmail !== existingEmail) {
        const nextConversation = syncConversationFromFlow(
          {
            ...input.conversation,
            clientWarnings: Array.from(
              new Set([
                ...(input.conversation.clientWarnings ?? []),
                "client_email_differs_from_directory",
              ]),
            ),
            requiresManualReview: true,
          },
          {
            ...flow,
            email: normalizedEmail,
            status: "collecting_pet",
          },
        );
        return {
          conversation: nextConversation,
          reply:
            "Gracias. He encontrado una ficha con este teléfono; dejamos ese email marcado para revisión y seguimos con la reserva. Dime el nombre de tu mascota o mascotas.",
          eventType: "reservation_flow_known_client_email_review",
          eventPayload: { matchType: input.conversation.clientMatchType },
        };
      }

      const knownPets = safeKnownClientPets(input.conversation);
      const singleKnownPet = knownPets.length === 1 ? knownPets[0] : undefined;
      const nextFlow: ConversationReservationFlow = {
        ...flow,
        email: normalizedEmail,
        status: singleKnownPet ? "collecting_dates" : "collecting_pet",
        petName: singleKnownPet ?? flow.petName,
        petNames: singleKnownPet ? [singleKnownPet] : flow.petNames,
        petCount: singleKnownPet ? 1 : flow.petCount,
        updatedAt: nowIso(now),
      };
      const conversation = syncConversationFromFlow(
        {
          ...input.conversation,
          clientEmail: normalizedEmail,
          clientStatus: "known",
          clientConfidence: "strong",
          clientMatchType: input.conversation.clientMatchType ?? "phone",
          tags: Array.from(new Set([...(input.conversation.tags ?? []), "cliente_habitual"])),
        },
        nextFlow,
      );
      return {
        conversation,
        reply:
          nextFlow.petName && nextFlow.status === "collecting_dates"
            ? `Gracias. Tengo registrada a ${nextFlow.petName}. ¿Qué fechas necesitas para la reserva?`
            : "Gracias. Dime el nombre de tu mascota o mascotas y las fechas de la reserva.",
        eventType: "reservation_flow_known_client_email_collected",
        eventPayload: { matchType: input.conversation.clientMatchType },
      };
    }

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
      const knownPets = safeClientRecordPets(client);
      const singleKnownPet = knownPets.length === 1 ? knownPets[0] : undefined;
      flow = {
        ...flow,
        clientKind: "habitual",
        email,
        ownerName: client?.nombre ?? flow.ownerName,
        status: singleKnownPet ? "collecting_dates" : "collecting_pet",
        petName: singleKnownPet ?? flow.petName,
        petNames: singleKnownPet ? [singleKnownPet] : flow.petNames,
        petCount: singleKnownPet ? 1 : flow.petCount,
      };
      const conversation = syncConversationFromFlow(
        {
          ...input.conversation,
          clientStatus: "known",
          clientConfidence: "strong",
          clientMatchType: "email",
          clientName: client?.nombre,
          clientEmail: email,
          clientPets: client?.mascotas,
          clientPetsCount: client?.mascotasCount,
          clientPetsMatchStatus: client?.mascotasMatchStatus,
          clientPetsMeta: client?.mascotasMeta,
          clientSource: identity.source,
          clientSheetName: client?.sheetName,
          clientSheetRow: client?.rowNumber,
          tags: Array.from(new Set([...(input.conversation.tags ?? []), "cliente_habitual"])),
        },
        flow,
      );
      return {
        conversation,
        reply:
          flow.petName && flow.status === "collecting_dates"
            ? `Genial. Tengo registrada a ${flow.petName}. ¿Qué fechas necesitas para la reserva?`
            : "Genial. Dime el nombre o los nombres de tu mascota/s, y después vemos fechas y horarios.",
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
    if (isUnknownPetNames(input.message)) {
      return {
        conversation: {
          ...syncConversationFromFlow(input.conversation, flow),
          mode: "human",
          humanRequested: true,
          requiresManualReview: true,
        },
        reply: "Sin problema. Podemos dejarlo pendiente para revisión, pero necesitaremos los nombres antes de confirmar la reserva.",
        eventType: "reservation_flow_pet_names_pending_review",
      };
    }

    const petDetails = extractPetDetails(input.message);
    flow = { ...flow, ...petDetails };

    if (petDetails.petCountInconsistency) {
      return {
        conversation: syncConversationFromFlow(input.conversation, flow),
        reply: nextCollectionReply(flow),
        eventType: "reservation_flow_pet_count_inconsistent",
        eventPayload: petDetails.petCountInconsistency,
      };
    }

    if (flow.petCount && flow.petCount > 4) {
      return {
        conversation: {
          ...syncConversationFromFlow(input.conversation, flow),
          mode: "human",
          humanRequested: true,
          requiresManualReview: true,
        },
        reply: "Para más de 4 perros necesitamos revisarlo con el equipo antes de darte precio.",
        eventType: "reservation_flow_pet_count_manual_review",
        eventPayload: { petCount: flow.petCount },
      };
    }

    if (flow.petCount && !flow.petName) {
      return {
        conversation: syncConversationFromFlow(input.conversation, flow),
        reply: nextCollectionReply(flow),
        eventType: "reservation_flow_waiting_pet_names",
        eventPayload: { petCount: flow.petCount },
      };
    }
  }

  if (flow.status === "collecting_dates") {
    if (needsMonthForDateTimeInput(input.message)) {
      return {
        conversation: syncConversationFromFlow(input.conversation, flow),
        reply: buildMissingMonthReply(),
        eventType: "reservation_flow_waiting_date_month",
        eventPayload: { status: flow.status },
      };
    }

    const awaitingTime = resolveAwaitingTimeInput(flow, input.message);
    if (awaitingTime?.reply) {
      const nextFlow = { ...flow, ...awaitingTime.patch, updatedAt: nowIso(now) };
      return {
        conversation: syncConversationFromFlow(input.conversation, nextFlow),
        reply: awaitingTime.reply,
        eventType: awaitingTime.eventType ?? "reservation_flow_waiting_time_preference",
        eventPayload: {
          status: nextFlow.status,
          ...awaitingTime.eventPayload,
        },
      };
    }

    flow = {
      ...flow,
      ...defined(awaitingTime?.patch ?? parseDatesAndTimes(input.message, now)),
    };
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
  const petDetailsFromMessage = extractPetDetails(input.message);
  const explicitPetCorrection = extractExplicitPetCorrection(input.message);
  const dateDetailsFromMessage = parseDatesAndTimes(input.message, now);
  const canUpdatePetName =
    current.status === "collecting_pet" || Boolean(explicitPetCorrection);
  const petPatch = explicitPetCorrection
    ? {
        petName: explicitPetCorrection,
        petNames: [explicitPetCorrection],
        petCount: 1,
        petCountInconsistency: undefined,
      }
    : petDetailsFromMessage;
  flow = {
    ...flow,
    email: extractEmail(input.message) ?? flow.email,
    ...(canUpdatePetName ? defined(petPatch) : {}),
    ...(canReadReservationDetails ? defined(dateDetailsFromMessage) : {}),
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
        ? "Anotado. Las visitas se coordinan de lunes a jueves de 10:00 a 18:00. Lo dejamos apuntado para el equipo. "
        : current.status === "collecting_visit" && flow.wantsVisit === false
          ? "De acuerdo, seguimos con la reserva. "
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
      ? "Anotado. Las visitas se coordinan de lunes a jueves de 10:00 a 18:00. Lo dejamos apuntado para el equipo. "
      : current.status === "collecting_visit" && flow.wantsVisit === false
        ? "De acuerdo, seguimos con la reserva. "
        : "";

  return {
    conversation,
    reply: `${visitPrefix}${
      explicitPetCorrection &&
      flow.status === "collecting_dates" &&
      !flow.checkInDate &&
      !flow.checkOutDate
        ? `Perfecto, sería para ${flow.petName}. ¿Qué fechas necesitas para la reserva?`
        : hasDatesAndNeedsTimes(flow) && flow.timePreferencePrompted
          ? TIME_CONTEXT_FALLBACK
          : nextCollectionReply(flow)
    }`,
    eventType: "reservation_flow_updated",
    eventPayload: {
      status: flow.status,
      clientKind: flow.clientKind,
      hasEmail: Boolean(flow.email),
      hasStayData: hasStayData(flow),
    },
  };
}

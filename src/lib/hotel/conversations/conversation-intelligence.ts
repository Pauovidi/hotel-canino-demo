import { getHotelRuntimeConfig } from "@/lib/hotel/config";
import { randomUUID } from "node:crypto";
import type { ConversationRecord, PendingPriceQuoteFlow } from "./types";

export type ConversationIntelligenceIntent =
  | "price_quote"
  | "reservation_or_availability"
  | "unknown";

export interface VagueDateMention {
  text: string;
  month?: number;
  monthName?: string;
  granularity: "early_month" | "mid_month" | "late_month" | "relative_week" | "unspecified_days";
}

export interface ConversationIntelligenceAnalysis {
  intent: ConversationIntelligenceIntent;
  matchedSignals: string[];
  petCount?: number;
  petBreeds: string[];
  checkInDate?: string;
  checkOutDate?: string;
  checkInLabel?: string;
  checkOutLabel?: string;
  relativeEntryMention?: string;
  vagueDateMention?: VagueDateMention;
  needsExactDate: boolean;
}

const PRICE_QUOTE_TTL_MS = 30 * 60 * 1000;

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

const MONTH_LABELS = [
  "",
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const BREEDS: Array<{ canonical: string; variants: string[] }> = [
  { canonical: "Rottweiler", variants: ["rottweiler"] },
  { canonical: "Labrador", variants: ["labrador"] },
  { canonical: "Golden Retriever", variants: ["golden retriever", "golden"] },
  { canonical: "Pastor Alemán", variants: ["pastor aleman"] },
  { canonical: "Pastor Belga", variants: ["pastor belga"] },
  { canonical: "Border Collie", variants: ["border collie"] },
  { canonical: "Bulldog Francés", variants: ["bulldog frances"] },
  { canonical: "Bulldog Inglés", variants: ["bulldog ingles"] },
  { canonical: "Yorkshire", variants: ["yorkshire", "yorkie"] },
  { canonical: "Chihuahua", variants: ["chihuahua"] },
  { canonical: "Beagle", variants: ["beagle"] },
  { canonical: "Boxer", variants: ["boxer"] },
  { canonical: "Dálmata", variants: ["dalmata"] },
  { canonical: "Husky", variants: ["husky"] },
  { canonical: "Shiba Inu", variants: ["shiba inu"] },
  { canonical: "Akita", variants: ["akita"] },
  { canonical: "Caniche", variants: ["caniche", "poodle"] },
  { canonical: "Bichón Maltés", variants: ["bichon maltes", "maltes"] },
  { canonical: "Cocker", variants: ["cocker"] },
  { canonical: "Teckel", variants: ["teckel", "dachshund"] },
  { canonical: "Galgo", variants: ["galgo"] },
  { canonical: "Podenco", variants: ["podenco"] },
  { canonical: "Mastín", variants: ["mastin"] },
  { canonical: "Doberman", variants: ["doberman"] },
  { canonical: "Schnauzer", variants: ["schnauzer"] },
  { canonical: "Pomerania", variants: ["pomerania"] },
  {
    canonical: "American Staffordshire",
    variants: ["american stanford", "american staffordshire", "amstaff"],
  },
  { canonical: "Pitbull", variants: ["pitbull", "pit bull"] },
  { canonical: "Mestizo", variants: ["mestizo"] },
];

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!,.;:()[\]{}"'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

function countWordToNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
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
  return map[normalizeText(value)];
}

function detectBreeds(normalized: string): string[] {
  return BREEDS.filter((breed) =>
    breed.variants.some((variant) => new RegExp(`\\b${variant}\\b`, "u").test(normalized)),
  ).map((breed) => breed.canonical);
}

function detectPetCount(normalized: string, petBreeds: string[]): number | undefined {
  const countToken = "(\\d|un|uno|una|dos|tres|cuatro|cinco|seis)";
  const explicit =
    normalized.match(new RegExp(`\\b${countToken}\\s+perr`, "u"))?.[1] ??
    normalized.match(new RegExp(`\\b(?:serian|son|tengo|para)\\s+${countToken}\\s+perr`, "u"))?.[1];
  const explicitCount = countWordToNumber(explicit);
  if (explicitCount) return explicitCount;

  if (/\bmi\s+perr[oa]\b/.test(normalized)) return 1;

  if (
    petBreeds.length === 1 &&
    BREEDS.some((breed) =>
      breed.variants.some((variant) => new RegExp(`\\b(?:un|una)\\s+${variant}\\b`, "u").test(normalized)),
    )
  ) {
    return 1;
  }

  const breedCount = normalized.match(new RegExp(`\\b${countToken}\\s+(?:${BREEDS.flatMap((b) => b.variants).join("|")})\\b`, "u"))?.[1];
  return countWordToNumber(breedCount);
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

function formatShortDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDate();
  const month = MONTH_LABELS[date.getUTCMonth() + 1];
  return `${day} de ${month}`;
}

function resolveRelativeEntry(normalized: string, now: Date): { date?: string; label?: string } {
  const weekdays: Record<string, number> = {
    lunes: 1,
    martes: 2,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6,
    domingo: 0,
  };
  const labels: Record<string, string> = {
    lunes: "lunes",
    martes: "martes",
    miercoles: "miércoles",
    jueves: "jueves",
    viernes: "viernes",
    sabado: "sábado",
    domingo: "domingo",
  };
  const match = normalized.match(/\b(?:este|esta|el|la)?\s*(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (!match) return {};

  const target = weekdays[match[1]];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const delta = (target - base.getUTCDay() + 7) % 7 || 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return { date: base.toISOString().slice(0, 10), label: `este ${labels[match[1]]}` };
}

function parseExactDateRange(normalized: string, now: Date) {
  const numeric = normalized.match(
    /\b(?:del|desde)?\s*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s*(?:al|hasta|a)\s*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/,
  );
  if (numeric) {
    const startDay = Number.parseInt(numeric[1], 10);
    const startMonth = Number.parseInt(numeric[2], 10);
    const endDay = Number.parseInt(numeric[4], 10);
    const endMonth = Number.parseInt(numeric[5], 10);
    const startYear = normalizeYear(numeric[3] ?? numeric[6], now, startMonth, startDay);
    const endYear = normalizeYear(numeric[6] ?? numeric[3], now, endMonth, endDay);
    const checkInDate = isoDate(startYear, startMonth, startDay);
    const checkOutDate = isoDate(endYear, endMonth, endDay);
    return checkInDate && checkOutDate
      ? { checkInDate, checkOutDate, checkInLabel: formatShortDate(checkInDate), checkOutLabel: formatShortDate(checkOutDate) }
      : {};
  }

  const monthNames = Object.keys(MONTHS).join("|");
  const natural = normalized.match(
    new RegExp(
      `\\b(?:del|desde)?\\s*(\\d{1,2})(?:\\s+de)?\\s*(${monthNames})?\\s*(?:al|hasta|a)\\s*(?:el\\s+)?(\\d{1,2})(?:\\s+de)?\\s*(${monthNames})?(?:\\s+de\\s+(\\d{2,4}))?\\b`,
      "u",
    ),
  );
  if (!natural) return {};

  const startMonth = MONTHS[natural[2] ?? ""] ?? MONTHS[natural[4] ?? ""];
  const endMonth = MONTHS[natural[4] ?? ""] ?? startMonth;
  if (!startMonth || !endMonth) return {};

  const startDay = Number.parseInt(natural[1], 10);
  const endDay = Number.parseInt(natural[3], 10);
  const startYear = normalizeYear(natural[5], now, startMonth, startDay);
  const endYear = normalizeYear(natural[5], now, endMonth, endDay);
  const checkInDate = isoDate(startYear, startMonth, startDay);
  const checkOutDate = isoDate(endYear, endMonth, endDay);
  return checkInDate && checkOutDate
    ? { checkInDate, checkOutDate, checkInLabel: formatShortDate(checkInDate), checkOutLabel: formatShortDate(checkOutDate) }
    : {};
}

function detectVagueDateMention(normalized: string): VagueDateMention | undefined {
  const monthNames = Object.keys(MONTHS).join("|");
  const monthVague = normalized.match(
    new RegExp(`\\b(principios|mediados|finales)\\s+de\\s+(${monthNames})\\b`, "u"),
  );
  if (monthVague) {
    const granularity = monthVague[1] === "principios"
      ? "early_month"
      : monthVague[1] === "mediados"
        ? "mid_month"
        : "late_month";
    const month = MONTHS[monthVague[2]];
    return {
      text: monthVague[0],
      month,
      monthName: MONTH_LABELS[month],
      granularity,
    };
  }

  if (/\bla\s+semana\s+que\s+viene\b/.test(normalized)) {
    return { text: "la semana que viene", granularity: "relative_week" };
  }

  const unspecificDays = normalized.match(new RegExp(`\\bunos\\s+dias\\s+en\\s+(${monthNames})\\b`, "u"));
  if (unspecificDays) {
    const month = MONTHS[unspecificDays[1]];
    return {
      text: unspecificDays[0],
      month,
      monthName: MONTH_LABELS[month],
      granularity: "unspecified_days",
    };
  }

  return undefined;
}

export function analyzeConversationIntelligence(
  message: string,
  now = new Date(),
): ConversationIntelligenceAnalysis {
  const normalized = normalizeText(message);
  const matchedSignals: string[] = [];
  const petBreeds = detectBreeds(normalized);
  const petCount = detectPetCount(normalized, petBreeds);
  const exactRange = parseExactDateRange(normalized, now);
  const relativeEntry = resolveRelativeEntry(normalized, now);
  const vagueDateMention = detectVagueDateMention(normalized);

  if (petBreeds.length > 0) matchedSignals.push("breed_detected");
  if (petCount) matchedSignals.push("pet_count_detected");
  if (exactRange.checkInDate && exactRange.checkOutDate) matchedSignals.push("exact_date_range_detected");
  if (relativeEntry.date) matchedSignals.push("relative_entry_date_detected");
  if (vagueDateMention) matchedSignals.push("vague_date_detected");

  const priceIntent =
    hasAny(normalized, [
      "precio",
      "cuesta",
      "coste",
      "tarifa",
      "presupuesto",
      "calcular",
      "que me cuesta",
      "cuanto me sale",
      "cuanto seria",
      "queria saber el precio",
      "queria saber que me cuesta",
    ]) || /\bcuanto\b/.test(normalized);

  const stayIntent =
    hasAny(normalized, [
      "residencia",
      "alojamiento",
      "estancia",
      "dejarlo",
      "dejarla",
      "dejaria",
      "lo dejaria",
      "la dejaria",
      "dejar a mi perro",
      "deja a mi perro",
      "cuidar",
      "guarderia",
      "necesito dejar",
      "seria para",
      "consultar disponibilidad",
      "teneis sitio",
      "tenéis sitio",
      "hay plaza",
      "quiero reservar",
      "me gustaria reservar",
      "se queda",
      "se quedaria",
      "lo llevo",
    ]) ||
    /\bpara\s+(?:un|una|dos|tres|cuatro)\b/.test(normalized) ||
    /\b(?:del|desde)?\s*\d{1,2}(?:[/-]|\s+(?:de\s+)?[a-z]+)\b.*\b(?:al|hasta|a)\b/.test(normalized);

  if (priceIntent) matchedSignals.push("price_quote_intent");
  if (stayIntent) matchedSignals.push("stay_intent");

  return {
    intent: priceIntent ? "price_quote" : stayIntent || petBreeds.length > 0 ? "reservation_or_availability" : "unknown",
    matchedSignals,
    petCount,
    petBreeds,
    checkInDate: exactRange.checkInDate ?? relativeEntry.date,
    checkOutDate: exactRange.checkOutDate,
    checkInLabel: exactRange.checkInLabel ?? relativeEntry.label,
    checkOutLabel: exactRange.checkOutLabel,
    relativeEntryMention: relativeEntry.label,
    vagueDateMention,
    needsExactDate: Boolean(vagueDateMention),
  };
}

export function calculateNights(checkInDate: string, checkOutDate: string): number {
  const start = Date.parse(`${checkInDate}T00:00:00.000Z`);
  const end = Date.parse(`${checkOutDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

export function calculateQuotePrice(petCount: number, nights: number): number {
  const tiers = getHotelRuntimeConfig().pricing.tiers;
  const band = Math.min(Math.max(petCount, 1), 4);
  const rate = tiers.find((tier) => tier.petCount === band)?.nightlyRate ?? tiers[0].nightlyRate;
  return rate * nights;
}

export function buildPriceQuoteReply(input: {
  petCount: number;
  checkInDate: string;
  checkOutDate: string;
}): string {
  const nights = calculateNights(input.checkInDate, input.checkOutDate);
  const price = calculateQuotePrice(input.petCount, nights);
  const dogLabel = input.petCount === 1 ? "1 perro" : `${input.petCount} perros`;
  return `Para ${dogLabel}, del ${formatShortDate(input.checkInDate)} al ${formatShortDate(input.checkOutDate)} serían ${nights} noches. El precio estimado es ${price} €. Si quieres, puedo comprobar disponibilidad para esas fechas.`;
}

export function buildNeedPetCountForQuoteReply(analysis: ConversationIntelligenceAnalysis): string {
  if (analysis.checkInDate && analysis.checkOutDate) {
    return `Claro. Para calcularlo del ${formatShortDate(analysis.checkInDate)} al ${formatShortDate(analysis.checkOutDate)} necesito saber cuántos perros serían.`;
  }
  return "Claro. Para calcular el precio necesito las fechas de entrada y salida, y cuántos perros serían.";
}

export function buildVagueDatePrecisionReply(analysis: ConversationIntelligenceAnalysis): string {
  const vague = analysis.vagueDateMention;
  if (analysis.relativeEntryMention && vague?.granularity === "early_month" && vague.monthName) {
    return `Perfecto. Entiendo entrada ${analysis.relativeEntryMention}. Para comprobar disponibilidad necesito que me confirmes el día exacto de salida a principios de ${vague.monthName} y, si puedes, la hora aproximada de entrada y salida.`;
  }
  if (vague?.granularity === "early_month" && vague.monthName) {
    return `Cuando dices principios de ${vague.monthName}, ¿qué día concreto sería la salida? Por ejemplo, entre el 1 y el 5.`;
  }
  if (vague?.granularity === "mid_month" && vague.monthName) {
    return `Cuando dices mediados de ${vague.monthName}, ¿qué día concreto sería?`;
  }
  if (vague?.granularity === "late_month" && vague.monthName) {
    return `Cuando dices finales de ${vague.monthName}, ¿qué día concreto sería?`;
  }
  return "Para comprobarlo necesito que me confirmes las fechas concretas de entrada y salida.";
}

export function buildBreedReservationReply(analysis: ConversationIntelligenceAnalysis): string {
  const breed = analysis.petBreeds[0];
  const prefix = breed
    ? `Perfecto, entiendo que sería una estancia para un ${breed}.`
    : "Perfecto, entiendo que sería una estancia.";
  if (analysis.needsExactDate) {
    return buildVagueDatePrecisionReply(analysis);
  }
  return `${prefix} ¿Qué día sería la entrada y qué día la salida?`;
}

export function buildPendingPriceQuoteFlow(input: {
  conversation: ConversationRecord;
  analysis: ConversationIntelligenceAnalysis;
  now: Date;
  status?: PendingPriceQuoteFlow["status"];
  estimatedPrice?: number;
  nights?: number;
}): PendingPriceQuoteFlow {
  return {
    flowId: input.conversation.pendingPriceQuoteFlow?.flowId ?? `price_quote_${randomUUID()}`,
    conversationId: input.conversation.id,
    phoneNormalized: input.conversation.phoneNormalized,
    status: input.status ?? (input.analysis.needsExactDate ? "needs_exact_date" : "collecting_pet_count"),
    source: "whatsapp",
    checkInDate: input.analysis.checkInDate,
    checkOutDate: input.analysis.checkOutDate,
    checkInLabel: input.analysis.checkInLabel,
    checkOutLabel: input.analysis.checkOutLabel,
    vagueDateMention: input.analysis.vagueDateMention?.text,
    needsExactDate: input.analysis.needsExactDate,
    petCount: input.analysis.petCount,
    petBreeds: input.analysis.petBreeds,
    nights: input.nights,
    estimatedPrice: input.estimatedPrice,
    createdAt: input.conversation.pendingPriceQuoteFlow?.createdAt ?? input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + PRICE_QUOTE_TTL_MS).toISOString(),
  };
}

export function isPendingPriceQuoteFlowLive(record: ConversationRecord, now = new Date()): boolean {
  return Boolean(
    record.pendingPriceQuoteFlow &&
      record.pendingPriceQuoteFlow.status !== "quoted" &&
      new Date(record.pendingPriceQuoteFlow.expiresAt).getTime() > now.getTime(),
  );
}

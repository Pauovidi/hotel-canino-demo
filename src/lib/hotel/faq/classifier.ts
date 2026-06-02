import { FAQ_KNOWLEDGE_ENTRIES, getFaqEntry } from "./catalog";
import { normalizeReceptionTime } from "../date-normalization";
import type { FaqClassification, FaqIntentId, FaqKnowledgeEntry, FaqSignalSet } from "./types";
import {
  countPhraseHits,
  countPatternHits,
  hasAnyPhrase,
  hasAnyPattern,
  normalizeFaqText,
  tokenizeFaqText,
} from "./text";

const DATE_PATTERNS = [
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\bdel?\s+\d{1,2}(?:\s+de\s+[a-z]+)?\s+al\s+\d{1,2}(?:\s+de\s+[a-z]+)?\b/,
  /\benero\b|\bfebrero\b|\bmarzo\b|\babril\b|\bmayo\b|\bjunio\b|\bjulio\b|\bagosto\b|\bseptiembre\b|\boctubre\b|\bnoviembre\b|\bdiciembre\b/,
] as const;

const TIME_PATTERNS = [
  /\ba las\s+\d{1,2}(?::\d{2})?\b/,
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}h\b/,
] as const;

const HUMAN_CONTACT_PHRASES = [
  "te puedo llamar",
  "os puedo llamar",
  "te llamo y te explico",
  "os llamo y os explico",
  "prefiero hablar con una persona",
  "caso especial",
  "tengo que explicaros algo",
  "te explico",
  "os cuento",
  "comportamiento complicado",
  "mi perro es muy especial",
] as const;

const AGGRESSIVE_BEHAVIOR_PHRASES = [
  "no se lleva bien",
  "reactivo",
  "reactiva",
  "agresivo",
  "agresiva",
  "muerde",
  "ha mordido",
  "conducta fuera de lo normal",
  "problema de conducta grave",
] as const;

const SEVERE_ANXIETY_PHRASES = [
  "ansiedad severa",
  "ansiedad extrema",
  "mucha ansiedad",
  "ansiedad muy fuerte",
  "ansiedad por separacion",
  "ansiedad de separacion",
  "panico cuando se queda solo",
  "panico al quedarse solo",
  "no sabe estar solo",
] as const;

const COMPLEX_MEDICATION_PHRASES = [
  "insulina",
  "epilepsia",
  "convulsiones",
  "medicacion compleja",
  "medicacion delicada",
  "tratamiento complejo",
  "tratamiento delicado",
  "varias medicaciones",
  "muchas medicinas",
] as const;

const SPECIAL_VETERINARY_PHRASES = [
  "caso veterinario",
  "caso veterinario delicado",
  "seguimiento veterinario",
  "problema neurologico",
  "recien operado",
  "recien operada",
  "postoperatorio",
  "veterinario nos ha dicho",
] as const;

const RESERVE_PHRASES = [
  "quiero reservar",
  "quiero dejar al perro",
  "quiero dejarlo",
  "me lo podeis coger",
  "me lo podéis coger",
  "quiero hacer la reserva",
  "os lo llevo",
] as const;

const HOW_TO_RESERVE_PHRASES = [
  "como hago una reserva",
  "como reservo",
  "donde reservo",
  "formulario",
  "reserva online",
  "como funciona la reserva",
  "como se reserva",
] as const;

const AVAILABILITY_PHRASES = [
  "teneis sitio",
  "tenéis sitio",
  "hay sitio",
  "hay hueco",
  "hay plaza",
  "hay disponibilidad",
  "disponibilidad",
  "plaza para",
  "hueco para",
] as const;

const WHATSAPP_PHRASES = ["whatsapp", "chat", "wasap", "wsp", "watsap"] as const;
const CONFIRMATION_PHRASES = ["confirmais", "confirmáis", "confirmacion", "confirmación", "confirmar"] as const;
const OUTSIDE_HOURS_PHRASES = [
  "fuera de horario",
  "antes de las 8",
  "despues de las 19:30",
  "después de las 19:30",
  "llego tarde",
  "recogerlo a las 20",
  "recogerlo a las 21",
  "dejarlo a las 7",
  "a las 20:00",
] as const;
const HOTEL_PRICE_PHRASES = ["cuanto vale", "cuánto vale", "cuanto cuesta", "cuánto cuesta", "tarifa", "precio"] as const;
const GUARDERIA_PHRASES = ["guarderia", "guardería", "unas horas", "de dia", "de día"] as const;
const BONO_PHRASES = ["bono", "10 dias", "10 días", "diez dias", "diez días"] as const;
const VACCINES_PHRASES = [
  "vacunas",
  "rabia",
  "polivalente",
  "tos de las perreras",
  "tos perrera",
  "microchip",
  "cartilla",
  "pasaporte",
  "desparasitacion",
  "desparasitación",
] as const;
const TRUST_RESIDENCE_CONTEXT_PHRASES = [
  "residencia",
  "residencia canina",
  "hotel canino",
  "dejar a mi perro ahi",
  "dejarlo ahi",
] as const;
const TRUST_RESIDENCE_QUESTION_PHRASES = [
  "recomendable",
  "es bueno",
  "es buena opcion",
  "buena opcion",
  "seguro",
  "estara bien",
  "estar bien",
  "me da miedo",
  "como se si",
  "es buena",
  "puedo confiar",
] as const;
const TRUST_RESIDENCE_DIRECT_PHRASES = [
  "es recomendable dejar a mi perro en una residencia",
  "es bueno dejarlo en una residencia canina",
  "es seguro dejar a mi perro ahi",
  "es seguro dejar a mi perro en una residencia",
  "mi perro estara bien en una residencia",
  "me da miedo dejar a mi perro en una residencia",
  "como se si una residencia canina es buena",
] as const;
const MEDICATION_PHRASES = ["medicacion", "medicación", "tratamiento", "pastillas", "pauta", "medicina"] as const;
const BEHAVIOR_PHRASES = [
  "caracter",
  "carácter",
  "comportamiento",
  "sociable",
  "reactivo",
  "agresivo",
  "especial",
  "miedoso",
  "miedosa",
] as const;
const FOOD_PHRASES = ["comida", "pienso", "alimentacion", "alimentación", "barf"] as const;
const PHOTOS_PHRASES = ["fotos", "videos", "vídeos", "video", "vídeo", "mandais", "mandáis"] as const;
const PELUQUERIA_PHRASES = [
  "peluqueria",
  "peluquería",
  "baño",
  "bano",
  "corte",
  "grooming",
  "servicios",
  "adiestramiento",
  "guarderia",
  "guardería",
] as const;
const VETERINARY_PHRASES = ["veterinario", "veterinaria", "urgencia", "emergencia", "24 horas"] as const;
const PAYMENT_PHRASES = [
  "pago",
  "pagar",
  "señal",
  "senal",
  "efectivo",
  "bizum",
  "transferencia",
  "tarjeta",
  "anticipo",
  "fianza",
  "cuando se paga",
  "cuándo se paga",
] as const;
const CANCELLATION_PHRASES = [
  "cancelacion",
  "cancelación",
  "cancelar",
  "anular",
  "cambiar la fecha",
  "cambiar fechas",
  "cambiar la reserva",
  "cambiar reserva",
  "modificar reserva",
  "no puedo ir",
] as const;
const LOCATION_PHRASES = ["donde estais", "dónde estáis", "direccion", "dirección", "ubicacion", "ubicación", "como llegar", "murcia", "sangonera"] as const;
const CONTACT_PHRASES = ["telefono", "teléfono", "email", "correo", "contacto", "llamaros", "llamar"] as const;
const VISIT_PHRASES = ["visitar", "visita", "ver las instalaciones", "conocer el hotel", "ver el hotel"] as const;
const WHAT_TO_BRING_PHRASES = ["que tengo que llevar", "qué tengo que llevar", "que llevar", "qué llevar", "llevar cama", "llevar comida", "comederos"] as const;
const FAMILY_PICKUP_PHRASES = ["familiar", "amigo", "otra persona", "recogerlo mi padre", "recogerlo mi madre", "lo recoge", "lo lleva"] as const;
const OTHER_SITE_PHRASES = ["recomendar otro sitio", "recomendais otro sitio", "recomendáis otro sitio", "otra residencia", "otro hotel canino", "alguien de confianza"] as const;
const TEMPERATURE_PHRASES = ["frio", "frío", "calor", "climatizada", "climatizacion", "climatización"] as const;
const OUTDOOR_TIME_PHRASES = ["aire libre", "patio", "jardin", "jardín", "cuanto tiempo fuera", "cuánto tiempo fuera", "salen fuera"] as const;
const STAY_FOLLOWUP_PHRASES = ["pasado la noche", "ha comido", "le habeis dado", "le habéis dado", "ha llorado", "como esta mi perro", "cómo está mi perro"] as const;

function extractAskedTime(normalizedText: string): string | null {
  const match =
    normalizedText.match(/\ba las\s+(\d{1,2})(?::(\d{2}))?\b/) ??
    normalizedText.match(/\b(\d{1,2}):(\d{2})\b/) ??
    normalizedText.match(/\b(\d{1,2})h\b/);

  if (!match) {
    return null;
  }

  return `${match[1].padStart(2, "0")}:${match[2] ?? "00"}`;
}

function hasTrustResidenceSignal(normalizedText: string) {
  if (hasAnyPhrase(normalizedText, TRUST_RESIDENCE_DIRECT_PHRASES)) {
    return true;
  }

  return (
    hasAnyPhrase(normalizedText, TRUST_RESIDENCE_CONTEXT_PHRASES) &&
    hasAnyPhrase(normalizedText, TRUST_RESIDENCE_QUESTION_PHRASES)
  );
}

function hasSpecialCaseSignal(normalizedText: string) {
  return (
    hasAnyPhrase(normalizedText, HUMAN_CONTACT_PHRASES) ||
    hasAnyPhrase(normalizedText, AGGRESSIVE_BEHAVIOR_PHRASES) ||
    hasAnyPhrase(normalizedText, SEVERE_ANXIETY_PHRASES) ||
    hasAnyPhrase(normalizedText, COMPLEX_MEDICATION_PHRASES) ||
    hasAnyPhrase(normalizedText, SPECIAL_VETERINARY_PHRASES)
  );
}

function detectSignalSet(text: string): FaqSignalSet {
  const normalizedText = normalizeFaqText(text);
  const tokens = tokenizeFaqText(text);
  const pickupDropTerms = hasAnyPhrase(normalizedText, ["recoger", "recogida", "dejar", "entrada", "salida"]);
  const askedTime = extractAskedTime(normalizedText);
  const explicitOutsideTime =
    Boolean(askedTime && normalizeReceptionTime(askedTime).wasAdjusted && pickupDropTerms);

  return {
    normalizedText,
    tokens,
    hasDateSignal: hasAnyPattern(normalizedText, DATE_PATTERNS),
    hasTimeSignal: hasAnyPattern(normalizedText, TIME_PATTERNS),
    hasReserveVerb: hasAnyPhrase(normalizedText, RESERVE_PHRASES),
    hasHowToReserveSignal: hasAnyPhrase(normalizedText, HOW_TO_RESERVE_PHRASES),
    hasAvailabilitySignal: hasAnyPhrase(normalizedText, AVAILABILITY_PHRASES),
    hasWhatsappSignal: hasAnyPhrase(normalizedText, WHATSAPP_PHRASES),
    hasConfirmationSignal: hasAnyPhrase(normalizedText, CONFIRMATION_PHRASES),
    hasOutsideHoursSignal:
      explicitOutsideTime || hasAnyPhrase(normalizedText, OUTSIDE_HOURS_PHRASES),
    hasHotelPriceSignal: hasAnyPhrase(normalizedText, HOTEL_PRICE_PHRASES),
    hasGuarderiaSignal: hasAnyPhrase(normalizedText, GUARDERIA_PHRASES),
    hasBonoSignal: hasAnyPhrase(normalizedText, BONO_PHRASES),
    hasVaccinesSignal: hasAnyPhrase(normalizedText, VACCINES_PHRASES),
    hasTrustResidenceSignal: hasTrustResidenceSignal(normalizedText),
    hasMedicationSignal: hasAnyPhrase(normalizedText, MEDICATION_PHRASES),
    hasBehaviorSignal: hasAnyPhrase(normalizedText, BEHAVIOR_PHRASES),
    hasFoodSignal: hasAnyPhrase(normalizedText, FOOD_PHRASES),
    hasPhotosSignal: hasAnyPhrase(normalizedText, PHOTOS_PHRASES),
    hasPeluqueriaSignal: hasAnyPhrase(normalizedText, PELUQUERIA_PHRASES),
    hasVeterinarySignal: hasAnyPhrase(normalizedText, VETERINARY_PHRASES),
    hasPaymentSignal: hasAnyPhrase(normalizedText, PAYMENT_PHRASES),
    hasCancellationSignal: hasAnyPhrase(normalizedText, CANCELLATION_PHRASES),
    hasLocationSignal: hasAnyPhrase(normalizedText, LOCATION_PHRASES),
    hasContactSignal: hasAnyPhrase(normalizedText, CONTACT_PHRASES),
    hasVisitSignal: hasAnyPhrase(normalizedText, VISIT_PHRASES),
    hasWhatToBringSignal: hasAnyPhrase(normalizedText, WHAT_TO_BRING_PHRASES),
    hasFamilyPickupSignal: hasAnyPhrase(normalizedText, FAMILY_PICKUP_PHRASES),
    hasOtherSiteRecommendationSignal: hasAnyPhrase(normalizedText, OTHER_SITE_PHRASES),
    hasTemperatureSignal: hasAnyPhrase(normalizedText, TEMPERATURE_PHRASES),
    hasOutdoorTimeSignal: hasAnyPhrase(normalizedText, OUTDOOR_TIME_PHRASES),
    hasStayFollowupSignal: hasAnyPhrase(normalizedText, STAY_FOLLOWUP_PHRASES),
    hasSpecialCaseSignal: hasSpecialCaseSignal(normalizedText),
  };
}

function buildDirectDecision(signals: FaqSignalSet): {
  intent: FaqIntentId;
  matchedSignals: string[];
} | null {
  if (signals.hasSpecialCaseSignal) {
    return {
      intent: "handoff_humano",
      matchedSignals: ["special_case_handoff"],
    };
  }

  if (signals.hasStayFollowupSignal) {
    return {
      intent: "faq_seguimiento_estancia",
      matchedSignals: ["stay_followup_safe_handoff"],
    };
  }

  if (signals.hasOtherSiteRecommendationSignal) {
    return {
      intent: "faq_recomendacion_otro_sitio",
      matchedSignals: ["external_recommendation"],
    };
  }

  if (signals.hasPeluqueriaSignal) {
    return {
      intent: "faq_peluqueria",
      matchedSignals: ["peluqueria_service"],
    };
  }

  if (signals.hasVisitSignal) {
    return {
      intent: "faq_visitas_hotel",
      matchedSignals: ["hotel_visit"],
    };
  }

  if (signals.hasFamilyPickupSignal) {
    return {
      intent: "faq_recogida_familiar",
      matchedSignals: ["family_pickup"],
    };
  }

  if (signals.hasWhatToBringSignal) {
    return {
      intent: "faq_que_llevar",
      matchedSignals: ["what_to_bring"],
    };
  }

  if (signals.hasTemperatureSignal) {
    return {
      intent: "faq_climatizacion",
      matchedSignals: ["temperature_climate"],
    };
  }

  if (signals.hasOutdoorTimeSignal) {
    return {
      intent: "faq_tiempo_aire_libre",
      matchedSignals: ["outdoor_time"],
    };
  }

  if (signals.hasAvailabilitySignal && signals.hasDateSignal) {
    return {
      intent: "workflow_disponibilidad",
      matchedSignals: ["availability_with_dates"],
    };
  }

  if (signals.hasReserveVerb && !signals.hasHowToReserveSignal) {
    return {
      intent: "workflow_reserva",
      matchedSignals: ["direct_booking_request"],
    };
  }

  if (signals.hasHowToReserveSignal || (signals.hasWhatsappSignal && signals.hasReserveVerb)) {
    return {
      intent: "faq_reserva_formulario",
      matchedSignals: ["reserve_via_form"],
    };
  }

  if (signals.hasWhatsappSignal && signals.hasConfirmationSignal) {
    return {
      intent: "faq_confirmacion_whatsapp",
      matchedSignals: ["whatsapp_confirmation"],
    };
  }

  if (signals.hasOutsideHoursSignal) {
    return {
      intent: "faq_fuera_de_horario",
      matchedSignals: ["outside_hours"],
    };
  }

  if (signals.hasTimeSignal || (signals.tokens.includes("horario") && !signals.hasHotelPriceSignal)) {
    return {
      intent: "faq_horario",
      matchedSignals: ["reception_schedule"],
    };
  }

  if (signals.hasGuarderiaSignal && signals.hasBonoSignal) {
    return {
      intent: "faq_bono_guarderia",
      matchedSignals: ["guarderia_bonus_price"],
    };
  }

  if (signals.hasGuarderiaSignal && signals.hasHotelPriceSignal) {
    return {
      intent: "faq_precio_guarderia",
      matchedSignals: ["guarderia_price"],
    };
  }

  if (signals.hasHotelPriceSignal) {
    return {
      intent: "faq_precio_hotel",
      matchedSignals: ["hotel_price"],
    };
  }

  if (signals.hasVaccinesSignal) {
    return {
      intent: "faq_vacunas",
      matchedSignals: ["health_requirements"],
    };
  }

  if (signals.hasMedicationSignal) {
    return {
      intent: "faq_medicacion",
      matchedSignals: ["medication_policy"],
    };
  }

  if (signals.hasBehaviorSignal) {
    return {
      intent: "faq_comportamiento",
      matchedSignals: ["behavior_review"],
    };
  }

  if (signals.hasFoodSignal) {
    return {
      intent: "faq_comida",
      matchedSignals: ["food_service"],
    };
  }

  if (signals.hasPhotosSignal) {
    return {
      intent: "faq_fotos",
      matchedSignals: ["photos_videos"],
    };
  }

  if (signals.hasVeterinarySignal) {
    return {
      intent: "faq_veterinario",
      matchedSignals: ["veterinary_support"],
    };
  }

  if (signals.hasTrustResidenceSignal) {
    return {
      intent: "faq_confianza_residencia",
      matchedSignals: ["trust_and_safety_residence"],
    };
  }

  if (signals.hasPaymentSignal) {
    return {
      intent: "faq_pago_senal",
      matchedSignals: ["payment_question"],
    };
  }

  if (signals.hasCancellationSignal) {
    return {
      intent: "faq_cancelacion",
      matchedSignals: ["cancellation_question"],
    };
  }

  if (signals.hasLocationSignal) {
    return {
      intent: "faq_ubicacion",
      matchedSignals: ["location_question"],
    };
  }

  if (signals.hasContactSignal) {
    return {
      intent: "faq_contacto",
      matchedSignals: ["contact_question"],
    };
  }

  return null;
}

function scoreKnowledgeEntry(entry: FaqKnowledgeEntry, normalizedText: string, tokens: string[]) {
  const phrasePool = [entry.question, ...entry.examples, ...entry.synonyms];
  const normalizedPool = phrasePool.map((value) => normalizeFaqText(value));
  const exactMatch = normalizedPool.includes(normalizedText);
  const phraseHits = countPhraseHits(normalizedText, normalizedPool);
  const tokenHits = tokens.filter(
    (token) =>
      token.length > 3 &&
      normalizedPool.some((phrase) => phrase.includes(token)),
  ).length;
  const patternHits =
    countPatternHits(normalizedText, DATE_PATTERNS) * (entry.outputType === "workflow" ? 2 : 0) +
    countPatternHits(normalizedText, TIME_PATTERNS) * (entry.intent === "faq_fuera_de_horario" ? 2 : 0);

  return exactMatch ? 100 : phraseHits * 10 + tokenHits * 2 + patternHits;
}

function buildClassification(
  intent: FaqIntentId,
  score: number,
  signals: FaqSignalSet,
  matchedSignals: string[],
  usedFallback: boolean,
): FaqClassification {
  const entry = getFaqEntry(intent);
  if (!entry) {
    throw new Error(`Intent FAQ no encontrado: ${intent}`);
  }

  return {
    intent,
    category: entry.category,
    outputType: entry.outputType,
    score,
    matchedSignals,
    usedFallback,
    signals,
  };
}

export function classifyFaqIntent(text: string): FaqClassification {
  const signals = detectSignalSet(text);
  const directDecision = buildDirectDecision(signals);

  if (directDecision) {
    return buildClassification(
      directDecision.intent,
      90,
      signals,
      directDecision.matchedSignals,
      false,
    );
  }

  const scoredEntries = FAQ_KNOWLEDGE_ENTRIES.map((entry) => ({
    entry,
    score: scoreKnowledgeEntry(entry, signals.normalizedText, signals.tokens),
  })).sort((left, right) => right.score - left.score);

  const topMatch = scoredEntries[0];
  if (topMatch && topMatch.score >= 10) {
    return buildClassification(
      topMatch.entry.intent,
      topMatch.score,
      signals,
      ["catalog_score_match"],
      false,
    );
  }

  return buildClassification(
    "handoff_humano",
    5,
    signals,
    ["safe_fallback_to_human"],
    true,
  );
}

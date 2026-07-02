import type { FaqIntentId } from "@/lib/hotel/faq";
import { matchFaqIntent } from "@/lib/hotel/knowledge/faq";
import { analyzeConversationIntelligence } from "./conversation-intelligence";
import { extractRelativeDateRange } from "./knowledge-base";
import {
  CONVERSATION_RESET_REPLY,
  type ConversationRenderKey,
} from "./authority/copy-renderer";

export { CONVERSATION_RESET_REPLY };

export type ConversationIntent =
  | "greeting"
  | "general_information"
  | "general_info_query"
  | "topic_info_query"
  | "mixed_reservation_and_info"
  | "informal_availability_query"
  | "faq_query"
  | "clarify_or_followup_question"
  | "price_query"
  | "schedule_hours_query"
  | "services_query"
  | "requirements_query"
  | "location_query"
  | "bath_service_query"
  | "faq_hours"
  | "faq_prices"
  | "faq_visits"
  | "faq_vaccines"
  | "faq_food"
  | "faq_what_to_bring"
  | "faq_photos_videos"
  | "faq_payment"
  | "faq_location"
  | "faq_services"
  | "faq_cancellation"
  | "faq_contact"
  | "price_quote"
  | "availability_request"
  | "reservation_start"
  | "reservation_confirm"
  | "reservation_cancel"
  | "reservation_modify"
  | "conversation_reset"
  | "human_handoff"
  | "stay_status_question"
  | "media_request"
  | "unknown";

export interface ConversationSlots {
  petName?: string;
  checkIn?: string;
  checkOut?: string;
  phone?: string;
  email?: string;
  reservationId?: string;
  requestedTopic?: string;
  topic?: string;
  petCount?: number;
  petBreeds?: string[];
  checkInDate?: string;
  checkOutDate?: string;
  dateRange?: string;
  dateStart?: string;
  dateEnd?: string;
  relativeDateRange?: string;
  reservationStage?: string;
  wantsToReserve?: boolean;
  wantsInfoBeforeReserve?: boolean;
  vagueDateMention?: string;
  needsExactDate?: boolean;
}

export interface ConversationNluResult {
  intent: ConversationIntent;
  slots: ConversationSlots;
  confidence: "high" | "medium" | "low";
  matchedSignals: string[];
}

export interface ConversationReplyPlan extends ConversationNluResult {
  handoff: boolean;
  renderKey: ConversationRenderKey;
  source: "conversation_nlu" | "faq_public_chat";
}

const SHARED_FAQ_BYPASS_INTENTS: ConversationIntent[] = [
  "conversation_reset",
  "greeting",
  "general_information",
  "general_info_query",
  "topic_info_query",
  "mixed_reservation_and_info",
  "informal_availability_query",
  "faq_query",
  "clarify_or_followup_question",
  "price_query",
  "schedule_hours_query",
  "services_query",
  "requirements_query",
  "location_query",
  "bath_service_query",
  "human_handoff",
  "stay_status_question",
  "price_quote",
  "reservation_start",
  "availability_request",
  "reservation_confirm",
  "reservation_cancel",
  "reservation_modify",
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

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function isConversationResetCommand(message: string): boolean {
  const normalized = normalizeText(message).replace(/^\/\s*/, "");
  return matchAny(normalized, [
    /^(reiniciar|reset|resetear|resetea|reinicia conversacion|reinicia la conversacion|empezar de nuevo|volver a empezar|borrar conversacion|limpiar conversacion|empezar otra vez|olvida lo anterior)$/,
  ]);
}

function hasGreetingPrefix(message: string): boolean {
  const normalized = normalizeText(message);
  return (
    /\bbuenos dias\b/.test(normalized) ||
    /\bbuen dia\b/.test(normalized) ||
    /\bbuenas tardes\b/.test(normalized) ||
    /\bbuenas noches\b/.test(normalized) ||
    /\bbuenas\b/.test(normalized) ||
    /\bhola+\b/.test(normalized) ||
    /\bhey\b/.test(normalized)
  );
}

function isGreetingLike(normalized: string): boolean {
  return matchAny(normalized, [
    /^(en primer lugar|primero|antes de nada|perdona|gracias)?\s*(hola+\s+)?(buenas|buen dia|buenos dias|buenas tardes|buenas noches)\s*$/,
    /^(hola+|hey|buenas)$/,
    /^hola+\s+buenas$/,
    /^(que tal|hola+\s+que tal)$/,
    /^(buenos dias|buen dia|buenas tardes|buenas noches)\s+(antes de nada|en primer lugar|primero)$/,
  ]);
}

export function isPureGreeting(message: string): boolean {
  return isGreetingLike(normalizeText(message));
}

export function isGreetingWithIntent(message: string): boolean {
  return hasGreetingPrefix(message) && !isPureGreeting(message);
}

export function isAffirmativeConfirmationUtterance(message: string): boolean {
  const normalized = normalizeText(message);
  if (!normalized) {
    return false;
  }

  return (
    /^(s+i+|claro|vale|ok|okay|perfecto|adelante|confirm(a|o|ar)|correcto|reservad|reserva)(\s+(por favor|gracias))?$/.test(
      normalized,
    ) ||
    [
      "si confirma",
      "si por favor",
      "si gracias",
      "vale gracias",
      "ok gracias",
      "perfecto gracias",
      "adelante por favor",
      "acepto",
      "acepto la reserva",
      "confirmo reserva",
      "confirmo la reserva",
      "de acuerdo",
      "esta bien",
      "esta ok",
      "anotala",
      "anotala por favor",
      "deja la reserva anotada",
      "dejala anotada",
      "dejadla anotada",
    ].includes(normalized)
  );
}

export function buildReservationConfirmReplyPlan(
  message: string,
  matchedSignal = "affirmative_contextual_confirmation",
): ConversationReplyPlan {
  const normalized = normalizeText(message);
  return {
    intent: "reservation_confirm",
    slots: extractSlots(message, normalized),
    confidence: "medium",
    matchedSignals: [matchedSignal],
    handoff: true,
    renderKey: "conversation.reservation_confirm",
    source: "conversation_nlu",
  };
}

function extractSlots(rawText: string, normalized: string): ConversationSlots {
  const email = rawText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = rawText.match(/(?:\+34\s*)?(?:\d[\s.-]?){9,}/)?.[0]?.trim();
  const reservationId = rawText.match(/\b(?:res|reserva)[-_ ]?[a-z0-9-]{4,}\b/i)?.[0];
  const petMatch =
    rawText.match(
      /\b(?:el\s+)?nombre\s+de\s+(?:mi\s+)?(?:mascota|perro|perra)\s+es\s+([A-ZÁÉÍÓÚÑ][\p{L}'-]{1,24})/u,
    ) ??
    rawText.match(/\b(?:mi\s+)?(?:mascota|perro|perra)\s+es\s+([A-ZÁÉÍÓÚÑ][\p{L}'-]{1,24})/u) ??
    rawText.match(/\b(?:mi\s+)?(?:mascota|perro|perra)\s+se\s+llama\s+([A-ZÁÉÍÓÚÑ][\p{L}'-]{1,24})/u) ??
    rawText.match(/\bse\s+llama\s+([A-ZÁÉÍÓÚÑ][\p{L}'-]{1,24})/u) ??
    rawText.match(/\b(?:para|perro|perra|mascota)\s+([A-ZÁÉÍÓÚÑ][\p{L}'-]{1,24})/u) ??
    rawText.match(/\b([A-ZÁÉÍÓÚÑ][\p{L}'-]{1,24})\s+(?:del|desde)\b/u);
  const dateRange = normalized.match(
    /\b(?:del|desde)\s+([0-9]{1,2}(?:\s+de\s+\w+)?)\s+(?:al|hasta)\s+([0-9]{1,2}(?:\s+de\s+\w+)?(?:\s+de\s+(?:\d{4}|este\s+ano|el\s+ano\s+que\s+viene|ano\s+que\s+viene))?)\b/,
  );

  return {
    email,
    phone,
    reservationId,
    petName: petMatch?.[1],
    checkIn: dateRange?.[1],
    checkOut: dateRange?.[2],
  };
}

export function classifyConversationIntent(message: string): ConversationNluResult {
  const normalized = normalizeText(message);
  const intelligence = analyzeConversationIntelligence(message);
  const baseSlots = extractSlots(message, normalized);
  const relativeDateRange = extractRelativeDateRange(message);
  const slots: ConversationSlots = {
    ...baseSlots,
    petCount: intelligence.petCount,
    petBreeds: intelligence.petBreeds.length ? intelligence.petBreeds : undefined,
    checkInDate: intelligence.checkInDate,
    checkOutDate: intelligence.checkOutDate,
    dateStart: intelligence.checkInDate,
    dateEnd: intelligence.checkOutDate,
    dateRange: relativeDateRange?.label,
    relativeDateRange: relativeDateRange?.id,
    vagueDateMention: intelligence.vagueDateMention?.text,
    needsExactDate: intelligence.needsExactDate || undefined,
  };
  const matchedSignals: string[] = [];

  function result(
    intent: ConversationIntent,
    confidence: ConversationNluResult["confidence"] = "high",
  ): ConversationNluResult {
    return { intent, slots, confidence, matchedSignals: [...matchedSignals] };
  }

  if (!normalized) {
    matchedSignals.push("empty");
    return result("unknown", "low");
  }

  if (isConversationResetCommand(message)) {
    matchedSignals.push("conversation_reset");
    return result("conversation_reset");
  }

  if (
    matchAny(normalized, [
      /\b(?:quiero|quisiera|me\s+gustaria|me\s+gustaría)\s+(?:hacer\s+)?(?:una\s+)?reserva\b.*\b(?:antes|primero)\b.*\b(?:dudas?|preguntar|saber|informacion|información|cosas)\b/,
      /\b(?:antes|primero)\b.*\b(?:dudas?|preguntar|saber|informacion|información|cosas)\b.*\b(?:reserva|reservar)\b/,
    ])
  ) {
    matchedSignals.push("mixed_reservation_and_info");
    slots.wantsToReserve = true;
    slots.wantsInfoBeforeReserve = true;
    slots.reservationStage = "held_before_info";
    return result("mixed_reservation_and_info");
  }

  if (
    relativeDateRange &&
    matchAny(normalized, [
      /\b(?:teneis|tenéis|hay|tendriais|tendríais)\s+(?:disponibilidad|sitio|hueco|plaza)\b/,
      /\b(?:disponibilidad|sitio|hueco|plaza)\b.*\b(?:finde|fin\s+de\s+semana|manana|pasado\s+manana|agosto|vacaciones|sabado|domingo|viernes)\b/,
    ])
  ) {
    matchedSignals.push("informal_availability_query");
    if (relativeDateRange) {
      matchedSignals.push(`relative_date:${relativeDateRange.id}`);
    }
    return result("informal_availability_query");
  }

  if (
    matchAny(normalized, [
      /\b(?:me\s+gustaria|me\s+gustaría|quiero|quisiera)\s+saber\s+mas\s+sobre\s+el\s+hotel\b/,
      /\b(?:saber\s+mas|mas\s+informacion|más\s+informacion|informacion\s+general|información\s+general)\b/,
      /\b(?:como\s+funciona|cómo\s+funciona)\s+(?:el\s+)?(?:hotel|alojamiento|residencia)\b/,
    ])
  ) {
    matchedSignals.push("general_info_query");
    slots.topic = "general_hotel_info";
    slots.requestedTopic = "general_hotel_info";
    return result("general_info_query");
  }

  if (
    intelligence.intent === "price_quote" &&
    (intelligence.checkInDate ||
      intelligence.checkOutDate ||
      intelligence.petCount ||
      intelligence.matchedSignals.includes("stay_intent"))
  ) {
    matchedSignals.push(...intelligence.matchedSignals);
    return result("price_quote");
  }

  if (
    matchAny(normalized, [
      /\bhorarios?\b/,
      /\bhorario de recepcion\b/,
      /\ba que hora\b/,
      /\bcuando puedo (dejar|recoger)\b/,
      /\bhora de (entrada|salida|recogida)\b/,
      /\bfranja de (entrada|salida)\b/,
      /\b(?:recoger|dejar|entrada|salida)\b.*\b(?:por la )?(?:manana|tarde)\b/,
    ])
  ) {
    matchedSignals.push("hours_explicit");
    return result("faq_hours");
  }

  if (
    hasAny(normalized, [
      "persona",
      "agente",
      "humano",
      "operador",
      "recepcion",
      "hablar con alguien",
      "hablar con una persona",
      "que me llamen",
      "llamada",
      "atencion",
      "responsable",
      "urgente",
      "emergencia",
      "asesor",
    ])
  ) {
    matchedSignals.push("human_handoff");
    return result("human_handoff");
  }

  if (
    isAffirmativeConfirmationUtterance(message) ||
    matchAny(normalized, [/\bsi\s*,?\s*(confirma|confirmo|confirmar)\b/, /\bconfirm(a|o|ar)\b/])
  ) {
    matchedSignals.push("reservation_confirm");
    return result("reservation_confirm", "medium");
  }

  if (
    matchAny(normalized, [
      /\bha\s+(comido|dormido|llorado|jugado|bebido)\b/,
      /\besta\s+(bien|tranquil[oa]|jugando|comiendo|durmiendo)\b/,
      /\bcomo\s+esta\b.*\b(perro|perra|mascota)\b/,
    ])
  ) {
    matchedSignals.push("stay_status");
    return result("stay_status_question");
  }

  if (hasAny(normalized, ["cancelar", "anular", "cancelacion"])) {
    matchedSignals.push("reservation_cancel");
    return result("reservation_cancel");
  }

  if (
    hasAny(normalized, [
      "cambiar fecha",
      "cambiar la fecha",
      "modificar",
      "cambio de fecha",
      "mover reserva",
    ]) ||
    matchAny(normalized, [
      /\bcambiar\s+(?:una|la|mi)?\s*reserva\b/,
      /\bcambiar\s+(?:fechas?|datos|entrada|salida|hora)\b/,
      /\bnecesito\s+cambiar\b/,
      /\bpuedo\s+cambiar\b/,
    ])
  ) {
    matchedSignals.push("reservation_modify");
    return result("reservation_modify");
  }

  if (matchAny(normalized, [/\bhay\s+(?:plaza|plazas|sitio|hueco)\b/])) {
    matchedSignals.push("availability_request");
    return result("availability_request");
  }

  if (
    hasAny(normalized, [
      "quiero reservar",
      "quiero hacer una reserva",
      "quiero hacer reserva",
      "hacer una reserva",
      "hacer reserva",
      "quiero una reserva",
      "necesito reservar",
      "quisiera reservar",
      "puedo reservar",
      "me gustaria reservar",
      "me gustaría reservar",
      "reservar",
      "quiero reservar para mi perro",
      "reserva para",
      "plaza para",
      "quiero dejar a mi perro",
      "quiero dejar a mi mascota",
      "dejar a mi perro",
      "dejar a mi mascota",
    ])
  ) {
    matchedSignals.push("reservation_start");
    return result(slots.checkIn || slots.checkOut ? "availability_request" : "reservation_start");
  }

  if (/\b(?:diferencia\s+entre\s+hotel\s+y\s+guarderia|hotel\s+y\s+guarderia)\b/.test(normalized)) {
    matchedSignals.push("hotel_daycare_difference");
    return result("faq_services");
  }

  if (intelligence.intent === "reservation_or_availability") {
    matchedSignals.push(...intelligence.matchedSignals);
    return result("availability_request", "medium");
  }

  if (
    (hasAny(normalized, ["busco", "necesito plaza", "necesito sitio"]) ||
      matchAny(normalized, [/\b(?:del|desde)\s+\d{1,2}\s+(?:al|hasta)\s+\d{1,2}\b/])) &&
    (slots.petName || slots.checkIn || slots.checkOut)
  ) {
    matchedSignals.push("availability_slot_filling");
    return result("availability_request", "medium");
  }

  if (
    hasAny(normalized, [
      "disponibilidad",
      "consultar disponibilidad",
      "quiero consultar disponibilidad",
      "mirar disponibilidad",
      "quiero mirar disponibilidad",
      "hay sitio",
      "hay hueco",
      "hay plaza",
      "hay plazas",
      "teneis sitio",
      "tenéis sitio",
      "teneis hueco",
      "tenéis hueco",
      "teneis plaza",
      "tenéis plaza",
    ])
  ) {
    matchedSignals.push("availability_request");
    return result("availability_request");
  }

  if (hasAny(normalized, ["foto", "fotos", "video", "videos", "vídeo", "vídeos"])) {
    matchedSignals.push("media");
    return result(hasAny(normalized, ["mandais", "mandáis", "enviais", "enviáis"]) ? "faq_photos_videos" : "media_request");
  }

  if (hasAny(normalized, ["horario", "hora", "entrada", "salida", "abrir", "cerrar"])) {
    matchedSignals.push("hours");
    return result("faq_hours");
  }

  if (hasAny(normalized, ["precio", "tarifa", "cuesta", "coste", "vale"])) {
    matchedSignals.push("prices");
    return result("faq_prices");
  }

  if (hasAny(normalized, ["visitar", "visita", "ver el hotel", "conocer el hotel"])) {
    matchedSignals.push("visits");
    return result("faq_visits");
  }

  if (hasAny(normalized, ["vacuna", "vacunas", "cartilla", "rabia", "tos de las perreras"])) {
    matchedSignals.push("vaccines");
    return result("faq_vaccines");
  }

  if (hasAny(normalized, ["comida", "pienso", "come", "alimentacion", "alimentación"])) {
    matchedSignals.push("food");
    return result("faq_food");
  }

  if (
    hasAny(normalized, [
      "que llevar",
      "qué llevar",
      "tengo que llevar",
      "hay que llevar",
      "traer",
      "llevo",
      "manta",
      "cama",
    ])
  ) {
    matchedSignals.push("what_to_bring");
    return result("faq_what_to_bring");
  }

  if (isGreetingLike(normalized)) {
    matchedSignals.push("greeting");
    return result("greeting");
  }

  if (
    hasAny(normalized, [
      "informacion",
      "información",
      "info",
      "duda",
      "dudas",
      "consulta",
      "consultar",
      "como funciona",
      "necesito informacion",
      "necesito información",
      "me puedes informar",
      "queria preguntar",
      "quería preguntar",
      "preguntar una cosa",
      "tengo una duda",
    ]) ||
    matchAny(normalized, [/^hola\s+(quiero|necesito|me gustaria)?\s*(informacion|info)$/])
  ) {
    matchedSignals.push("general_information");
    return result("general_information");
  }

  matchedSignals.push("unknown");
  return result("unknown", "low");
}

function mapFaqIntent(intent: FaqIntentId): ConversationIntent {
  switch (intent) {
    case "faq_horario":
    case "faq_fuera_de_horario":
      return "faq_hours";
    case "faq_precio_hotel":
    case "faq_precio_guarderia":
    case "faq_bono_guarderia":
      return "faq_prices";
    case "faq_visitas_hotel":
    case "faq_recogida_familiar":
      return "faq_visits";
    case "faq_vacunas":
    case "faq_que_llevar":
      return intent === "faq_que_llevar" ? "faq_what_to_bring" : "faq_vaccines";
    case "faq_comida":
      return "faq_food";
    case "faq_fotos":
    case "faq_seguimiento_estancia":
      return "faq_photos_videos";
    case "faq_pago_senal":
      return "faq_payment";
    case "faq_ubicacion":
      return "faq_location";
    case "faq_contacto":
      return "faq_contact";
    case "faq_cancelacion":
      return "faq_cancellation";
    case "faq_peluqueria":
    case "faq_veterinario":
    case "faq_medicacion":
    case "faq_comportamiento":
    case "faq_confianza_residencia":
    case "faq_climatizacion":
    case "faq_tiempo_aire_libre":
    case "faq_recomendacion_otro_sitio":
    case "faq_reserva_formulario":
    case "faq_confirmacion_whatsapp":
      return "faq_services";
    case "workflow_disponibilidad":
      return "availability_request";
    case "workflow_reserva":
      return "reservation_start";
    case "handoff_humano":
      return "human_handoff";
  }
}

export function buildConversationReplyPlan(message: string): ConversationReplyPlan {
  const nlu = classifyConversationIntent(message);
  let faqMatch: ReturnType<typeof matchFaqIntent> | undefined;
  const getFaqMatch = () => {
    faqMatch ??= matchFaqIntent(message);
    return faqMatch;
  };

  if (!SHARED_FAQ_BYPASS_INTENTS.includes(nlu.intent)) {
    const faqMatch = getFaqMatch();

    if (faqMatch) {
      return {
        ...nlu,
        intent: mapFaqIntent(faqMatch.intent),
        confidence: faqMatch.isFallback ? "medium" : "high",
        matchedSignals: Array.from(
          new Set([
            ...nlu.matchedSignals,
            ...faqMatch.resolution.matchedSignals,
            faqMatch.intent,
            faqMatch.isFallback ? "concrete_question_uncovered" : "shared_faq_match",
          ]),
        ),
        handoff: faqMatch.isFallback || faqMatch.resolution.outputType === "handoff",
        renderKey: "conversation.faq_reply",
        source: "faq_public_chat",
      };
    }
  }

  switch (nlu.intent) {
    case "greeting":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.greeting",
        source: "conversation_nlu",
      };
    case "general_information":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.general_information",
        source: "conversation_nlu",
      };
    case "general_info_query":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.general_hotel_info",
        source: "conversation_nlu",
      };
    case "mixed_reservation_and_info":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.mixed_reservation_info_intro",
        source: "conversation_nlu",
      };
    case "informal_availability_query":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.availability_informal_collect_details",
        source: "conversation_nlu",
      };
    case "topic_info_query":
    case "faq_query":
    case "clarify_or_followup_question":
    case "price_query":
    case "schedule_hours_query":
    case "services_query":
    case "requirements_query":
    case "location_query":
    case "bath_service_query":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.kb_topic_answer",
        source: "conversation_nlu",
      };
    case "human_handoff":
      return { ...nlu, handoff: true, renderKey: "conversation.human_handoff", source: "conversation_nlu" };
    case "stay_status_question":
      return { ...nlu, handoff: true, renderKey: "conversation.stay_status", source: "conversation_nlu" };
    case "reservation_start":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.reservation_start",
        source: "conversation_nlu",
      };
    case "availability_request":
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.availability_request",
        source: "conversation_nlu",
      };
    case "reservation_confirm":
      return { ...nlu, handoff: true, renderKey: "conversation.reservation_confirm", source: "conversation_nlu" };
    case "reservation_cancel":
      return { ...nlu, handoff: false, renderKey: "conversation.reservation_cancel", source: "conversation_nlu" };
    case "reservation_modify":
      return { ...nlu, handoff: false, renderKey: "conversation.reservation_modify", source: "conversation_nlu" };
    case "conversation_reset":
      return { ...nlu, handoff: false, renderKey: "conversation.reset", source: "conversation_nlu" };
    case "price_quote": {
      if (nlu.slots.needsExactDate) {
        return {
          ...nlu,
          handoff: false,
          renderKey: "conversation.dynamic_reply",
          source: "conversation_nlu",
        };
      }
      if (nlu.slots.checkInDate && nlu.slots.checkOutDate && nlu.slots.petCount) {
        return {
          ...nlu,
          handoff: false,
          renderKey: "conversation.dynamic_reply",
          source: "conversation_nlu",
        };
      }
      return {
        ...nlu,
        handoff: false,
        renderKey: "conversation.dynamic_reply",
        source: "conversation_nlu",
      };
    }
    case "faq_hours":
    case "faq_prices":
    case "faq_visits":
    case "faq_vaccines":
    case "faq_food":
    case "faq_what_to_bring":
    case "faq_photos_videos":
    case "media_request":
    case "faq_payment":
    case "faq_location":
    case "faq_services":
    case "faq_cancellation":
    case "faq_contact": {
      const faqMatch = getFaqMatch();
      return {
        ...nlu,
        handoff: Boolean(faqMatch?.isFallback || faqMatch?.resolution.outputType === "handoff"),
        renderKey: faqMatch ? "conversation.faq_reply" : "conversation.unknown",
        source: faqMatch ? "faq_public_chat" : "conversation_nlu",
      };
    }
    case "unknown":
      return { ...nlu, handoff: false, renderKey: "conversation.unknown", source: "conversation_nlu" };
  }
}

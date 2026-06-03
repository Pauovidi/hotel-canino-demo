import type { FaqIntentId } from "@/lib/hotel/faq";
import { matchFaqIntent } from "@/lib/hotel/knowledge/faq";

export type ConversationIntent =
  | "greeting"
  | "general_information"
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
}

export interface ConversationNluResult {
  intent: ConversationIntent;
  slots: ConversationSlots;
  confidence: "high" | "medium" | "low";
  matchedSignals: string[];
}

export interface ConversationReplyPlan extends ConversationNluResult {
  reply: string;
  handoff: boolean;
  source: "conversation_nlu" | "faq_public_chat";
}

const GENERAL_INFORMATION_REPLY =
  "Claro. Te puedo ayudar con horarios, visitas, reservas, vacunas, alimentación, qué traer y funcionamiento del hotel. ¿Sobre qué necesitas información?";

const HUMAN_HANDOFF_REPLY =
  "Perfecto, te paso con una persona del equipo. En cuanto puedan te responderán por aquí.";

const STAY_STATUS_REPLY =
  "Para darte una respuesta real sobre cómo está tu perro, lo revisa una persona del equipo y te contestamos por aquí.";

const UNKNOWN_REPLY =
  "Perdona, no te he entendido bien. ¿Quieres hacer una reserva, consultar disponibilidad o resolver alguna duda del hotel?";

const RESERVATION_START_REPLY =
  "Te ayudo con la reserva. Dime, por favor, la fecha de entrada, la fecha de salida y el nombre de tu mascota.";

const AVAILABILITY_REQUEST_REPLY =
  "Para consultar disponibilidad, dime la fecha de entrada, la fecha de salida y el nombre de tu mascota.";

const RESERVATION_CONFIRM_REPLY =
  "Para confirmar una reserva necesitamos una propuesta válida revisada por el equipo. Si ya tienes una solicitud en marcha, te paso con una persona para confirmarla con seguridad.";

const RESERVATION_CANCEL_REPLY =
  "Para cancelar una reserva necesito localizarla primero. Envíame el identificador de reserva, el teléfono usado o el nombre del perro, y lo revisa una persona del equipo.";

const RESERVATION_MODIFY_REPLY =
  "Para cambiar fechas o datos de una reserva, envíame el identificador de reserva o el nombre del perro y las nuevas fechas. Lo revisa una persona del equipo antes de confirmar nada.";

const CONVERSATION_RESET_REPLY = "Reiniciado.";

const SHARED_FAQ_BYPASS_INTENTS: ConversationIntent[] = [
  "conversation_reset",
  "greeting",
  "general_information",
  "human_handoff",
  "stay_status_question",
  "reservation_start",
  "availability_request",
  "reservation_confirm",
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

function greetingPrefix(message: string): string | undefined {
  const normalized = normalizeText(message);
  if (/\bbuenos dias\b/.test(normalized) || /\bbuen dia\b/.test(normalized)) {
    return "Buenos días.";
  }
  if (/\bbuenas tardes\b/.test(normalized)) {
    return "Buenas tardes.";
  }
  if (/\bbuenas noches\b/.test(normalized)) {
    return "Buenas noches.";
  }
  if (/\bbuenas\b/.test(normalized)) {
    return "Buenas.";
  }
  if (/\bhola+\b/.test(normalized) || /\bhey\b/.test(normalized)) {
    return "¡Hola!";
  }
  return undefined;
}

function withGreeting(message: string, reply: string): string {
  const prefix = greetingPrefix(message);
  return prefix ? `${prefix} ${reply}` : reply;
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
  return Boolean(greetingPrefix(message)) && !isPureGreeting(message);
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
      "confirmo reserva",
      "confirmo la reserva",
      "de acuerdo",
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
    reply: RESERVATION_CONFIRM_REPLY,
    handoff: true,
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
  const slots = extractSlots(message, normalized);
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

  if (
    matchAny(normalized, [
      /^(reiniciar|reset|resetea|reinicia conversacion|empezar de nuevo|volver a empezar|borrar conversacion|empezar otra vez|olvida lo anterior)$/,
    ])
  ) {
    matchedSignals.push("conversation_reset");
    return result("conversation_reset");
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
      "cambiar reserva",
    ])
  ) {
    matchedSignals.push("reservation_modify");
    return result("reservation_modify");
  }

  if (
    isAffirmativeConfirmationUtterance(message) ||
    matchAny(normalized, [/\bsi\s*,?\s*(confirma|confirmo|confirmar)\b/, /\bconfirm(a|o|ar)\b/])
  ) {
    matchedSignals.push("reservation_confirm");
    return result("reservation_confirm", "medium");
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

  if (!SHARED_FAQ_BYPASS_INTENTS.includes(nlu.intent)) {
    const faqMatch = matchFaqIntent(message);

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
        reply: faqMatch.reply,
        handoff: faqMatch.isFallback || faqMatch.resolution.outputType === "handoff",
        source: "faq_public_chat",
      };
    }
  }

  switch (nlu.intent) {
    case "greeting":
      return {
        ...nlu,
        reply: `${greetingPrefix(message) ?? "¡Hola!"} ¿En qué podemos ayudarte?`,
        handoff: false,
        source: "conversation_nlu",
      };
    case "general_information":
      return {
        ...nlu,
        reply: withGreeting(message, GENERAL_INFORMATION_REPLY),
        handoff: false,
        source: "conversation_nlu",
      };
    case "human_handoff":
      return { ...nlu, reply: HUMAN_HANDOFF_REPLY, handoff: true, source: "conversation_nlu" };
    case "stay_status_question":
      return { ...nlu, reply: STAY_STATUS_REPLY, handoff: true, source: "conversation_nlu" };
    case "reservation_start":
      return {
        ...nlu,
        reply: withGreeting(message, RESERVATION_START_REPLY),
        handoff: false,
        source: "conversation_nlu",
      };
    case "availability_request":
      return {
        ...nlu,
        reply: withGreeting(message, AVAILABILITY_REQUEST_REPLY),
        handoff: false,
        source: "conversation_nlu",
      };
    case "reservation_confirm":
      return { ...nlu, reply: RESERVATION_CONFIRM_REPLY, handoff: true, source: "conversation_nlu" };
    case "reservation_cancel":
      return { ...nlu, reply: RESERVATION_CANCEL_REPLY, handoff: true, source: "conversation_nlu" };
    case "reservation_modify":
      return { ...nlu, reply: RESERVATION_MODIFY_REPLY, handoff: true, source: "conversation_nlu" };
    case "conversation_reset":
      return { ...nlu, reply: CONVERSATION_RESET_REPLY, handoff: false, source: "conversation_nlu" };
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
      const faqMatch = matchFaqIntent(message);
      return {
        ...nlu,
        reply: faqMatch?.reply ?? UNKNOWN_REPLY,
        handoff: Boolean(faqMatch?.isFallback || faqMatch?.resolution.outputType === "handoff"),
        source: faqMatch ? "faq_public_chat" : "conversation_nlu",
      };
    }
    case "unknown":
      return { ...nlu, reply: UNKNOWN_REPLY, handoff: false, source: "conversation_nlu" };
  }
}

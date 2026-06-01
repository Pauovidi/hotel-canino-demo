import { resolvePublicChatReply } from "@/lib/hotel/faq/public-chat";

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
  "¡Hola! Claro, puedo ayudarte con información sobre horarios, visitas, reservas, vacunas, comida, qué traer o funcionamiento del hotel. ¿Sobre qué necesitas información?";

const GREETING_REPLY = "¡Hola! ¿En qué podemos ayudarte?";

const HUMAN_HANDOFF_REPLY =
  "Perfecto, te paso con una persona del equipo. En cuanto puedan te responderán por aquí.";

const STAY_STATUS_REPLY =
  "Para darte una respuesta real sobre cómo está tu perro, lo revisa una persona del equipo y te contestamos por aquí.";

const UNKNOWN_REPLY =
  "No estoy seguro de haberlo entendido del todo. ¿Quieres información general, consultar disponibilidad o hablar con una persona del equipo?";

const RESERVATION_START_REPLY =
  "Claro, te ayudo con la reserva. Dime, por favor, la fecha de entrada, la fecha de salida y el nombre de tu mascota.";

const RESERVATION_CONFIRM_REPLY =
  "Para confirmar una reserva necesitamos una propuesta válida revisada por el equipo. Si ya tienes una solicitud en marcha, te paso con una persona para confirmarla con seguridad.";

const RESERVATION_CANCEL_REPLY =
  "Para cancelar una reserva necesito localizarla primero. Envíame el identificador de reserva, el teléfono usado o el nombre del perro, y lo revisa una persona del equipo.";

const RESERVATION_MODIFY_REPLY =
  "Para cambiar fechas o datos de una reserva, envíame el identificador de reserva o el nombre del perro y las nuevas fechas. Lo revisa una persona del equipo antes de confirmar nada.";

const CONVERSATION_RESET_REPLY =
  "Perfecto, empezamos de nuevo. ¿Quieres información general, consultar disponibilidad o hablar con una persona del equipo?";

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
      /^(reiniciar|reset|empezar de nuevo|volver a empezar|borrar conversacion|empezar otra vez|olvida lo anterior)$/,
    ])
  ) {
    matchedSignals.push("conversation_reset");
    return result("conversation_reset");
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
      "hacer una reserva",
      "quiero una reserva",
      "necesito reservar",
      "me gustaria reservar",
      "me gustaría reservar",
      "reservar",
      "reserva para",
      "plaza para",
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

  if (
    matchAny(normalized, [
      /^(hola+\s+)?(buenas|buen dia|buenos dias|buenas tardes|buenas noches)$/,
      /^(hey|hola+)$/,
      /^hola+\s+buenas$/,
    ])
  ) {
    matchedSignals.push("greeting");
    return result("greeting");
  }

  if (
    hasAny(normalized, ["informacion", "información", "info", "dudas", "como funciona"]) ||
    matchAny(normalized, [/^hola\s+(quiero|necesito|me gustaria)?\s*(informacion|info)$/])
  ) {
    matchedSignals.push("general_information");
    return result("general_information");
  }

  matchedSignals.push("unknown");
  return result("unknown", "low");
}

function faqReply(message: string) {
  return resolvePublicChatReply(message).text;
}

export function buildConversationReplyPlan(message: string): ConversationReplyPlan {
  const nlu = classifyConversationIntent(message);

  switch (nlu.intent) {
    case "greeting":
      return { ...nlu, reply: GREETING_REPLY, handoff: false, source: "conversation_nlu" };
    case "general_information":
      return { ...nlu, reply: GENERAL_INFORMATION_REPLY, handoff: false, source: "conversation_nlu" };
    case "human_handoff":
      return { ...nlu, reply: HUMAN_HANDOFF_REPLY, handoff: true, source: "conversation_nlu" };
    case "stay_status_question":
      return { ...nlu, reply: STAY_STATUS_REPLY, handoff: true, source: "conversation_nlu" };
    case "reservation_start":
    case "availability_request":
      return { ...nlu, reply: RESERVATION_START_REPLY, handoff: false, source: "conversation_nlu" };
    case "reservation_confirm":
      return { ...nlu, reply: RESERVATION_CONFIRM_REPLY, handoff: true, source: "conversation_nlu" };
    case "reservation_cancel":
      return { ...nlu, reply: RESERVATION_CANCEL_REPLY, handoff: true, source: "conversation_nlu" };
    case "reservation_modify":
      return { ...nlu, reply: RESERVATION_MODIFY_REPLY, handoff: true, source: "conversation_nlu" };
    case "conversation_reset":
      return { ...nlu, reply: CONVERSATION_RESET_REPLY, handoff: false, source: "conversation_nlu" };
    case "faq_hours":
      return { ...nlu, reply: faqReply("¿Cuál es vuestro horario?"), handoff: false, source: "faq_public_chat" };
    case "faq_prices":
      return { ...nlu, reply: faqReply("¿Cuánto cuesta el hotel?"), handoff: false, source: "faq_public_chat" };
    case "faq_visits":
      return { ...nlu, reply: faqReply("¿Puedo visitar el hotel?"), handoff: false, source: "faq_public_chat" };
    case "faq_vaccines":
      return { ...nlu, reply: faqReply("¿Qué vacunas necesita?"), handoff: false, source: "faq_public_chat" };
    case "faq_food":
      return { ...nlu, reply: faqReply("¿Tengo que llevar comida?"), handoff: false, source: "faq_public_chat" };
    case "faq_what_to_bring":
      return { ...nlu, reply: faqReply("¿Qué tengo que llevar?"), handoff: false, source: "faq_public_chat" };
    case "faq_photos_videos":
    case "media_request":
      return { ...nlu, reply: faqReply("¿Mandáis fotos o vídeos?"), handoff: false, source: "faq_public_chat" };
    case "unknown":
      return { ...nlu, reply: UNKNOWN_REPLY, handoff: false, source: "conversation_nlu" };
  }
}

import { describe, expect, it } from "vitest";
import {
  buildConversationReplyPlan,
  classifyConversationIntent,
  isAffirmativeConfirmationUtterance,
  isPureGreeting,
} from "./nlu";
import { renderConversationReplyPlan } from "./authority/copy-renderer";

function buildRenderedPlan(message: string) {
  const plan = buildConversationReplyPlan(message);
  return { plan, reply: renderConversationReplyPlan(plan, message) };
}

function renderPlan(message: string): string {
  return buildRenderedPlan(message).reply;
}

describe("conversation NLU", () => {
  it.each([
    ["Hola", "greeting"],
    ["hola buenos días", "greeting"],
    ["Hola, buenos días", "greeting"],
    ["buenas tardes", "greeting"],
    ["hola buenas tardes", "greeting"],
    ["buenas noches", "greeting"],
    ["hola buenas noches", "greeting"],
    ["hola, qué tal", "greeting"],
    ["En primer lugar, buenos días", "greeting"],
    ["primero, buenos días", "greeting"],
    ["antes de nada, buenos días", "greeting"],
    ["buenos días, antes de nada", "greeting"],
    ["buenas tardes, quería información", "general_information"],
    ["buenas, quería hacer una consulta", "general_information"],
    ["hola, quería preguntar una cosa", "general_information"],
    ["hola, tengo una duda", "general_information"],
    ["hola, quería información", "general_information"],
    ["Hola, quiero información", "general_information"],
    ["Buenos días, me gustaría saber más sobre el hotel", "general_info_query"],
    ["Quiero hacer una reserva pero me gustaría saber antes algunas cosas", "mixed_reservation_and_info"],
    ["Buenos días, tenéis disponibilidad para este finde?", "informal_availability_query"],
    ["¿Qué tengo que llevar?", "faq_what_to_bring"],
    ["¿Puedo visitar el hotel?", "faq_visits"],
    ["¿Qué vacunas necesita?", "faq_vaccines"],
    ["¿Mandáis fotos o vídeos?", "faq_photos_videos"],
    ["¿Tenéis sitio del 14 al 18 de abril?", "availability_request"],
    ["Si una residencia para un Rottweiler", "availability_request"],
    ["lo dejaría este sábado", "availability_request"],
    ["se quedaría del 12 al 18", "availability_request"],
    ["necesito dejar a mi perro una semana", "reservation_start"],
    ["tenéis sitio para un Rottweiler", "availability_request"],
    ["Hola! Querría saber el precio desde 30 junio hasta 8 julio", "price_quote"],
    ["quería saber que me cuesta deja a mi perro del 30 de junio al 8 de julio", "price_quote"],
    ["cuánto me cuesta para dos perros del 1 al 5 de agosto", "price_quote"],
    ["quiero hacer una reserva", "reservation_start"],
    ["quiero hacer reserva", "reservation_start"],
    ["quisiera reservar", "reservation_start"],
    ["puedo reservar", "reservation_start"],
    ["quiero mirar disponibilidad", "availability_request"],
    ["disponibilidad", "availability_request"],
    ["Buenos días quiero hacer una reserva", "reservation_start"],
    ["Buenos días, quiero consultar disponibilidad", "availability_request"],
    ["Quiero reservar para Luna del 10 al 15 de agosto", "availability_request"],
    ["Mi mascota se llama Toby y busco del 29 al 31 de diciembre de este año", "availability_request"],
    ["si", "reservation_confirm"],
    ["Sí, confirma", "reservation_confirm"],
    ["Quiero cancelar mi reserva", "reservation_cancel"],
    ["Quiero cambiar la fecha", "reservation_modify"],
    ["reiniciar", "conversation_reset"],
    ["Reiniciar", "conversation_reset"],
    ["/reiniciar", "conversation_reset"],
    ["reset", "conversation_reset"],
    ["/reset", "conversation_reset"],
    ["resetear", "conversation_reset"],
    ["empezar de nuevo", "conversation_reset"],
    ["limpiar conversación", "conversation_reset"],
    ["Quiero hablar con una persona", "human_handoff"],
    ["¿Ha comido mi perro?", "stay_status_question"],
  ] as const)("classifies %s as %s", (message, intent) => {
    expect(classifyConversationIntent(message).intent).toBe(intent);
  });

  it.each([
    "si",
    "sí",
    "sii",
    "siii",
    "claro",
    "vale",
    "ok",
    "okay",
    "perfecto",
    "adelante",
    "confirma",
    "confirmo",
    "confirmar",
    "sí confirma",
    "si confirma",
    "de acuerdo",
    "está bien",
    "está ok",
    "correcto",
    "anótala",
    "si por favor",
    "sí por favor",
    "ok gracias",
    "vale gracias",
    "adelante por favor",
    "confirmo reserva",
    "confirmo la reserva",
    "deja la reserva anotada",
    "anótala por favor",
    "dejadla anotada",
    "déjala anotada",
    "reservad",
    "reserva",
  ])("detects %s as a contextual affirmative confirmation", (message) => {
    expect(isAffirmativeConfirmationUtterance(message)).toBe(true);
  });

  it("extracts slot-filling availability details from natural follow-up copy", () => {
    const result = classifyConversationIntent(
      "Mi mascota se llama Toby y busco del 29 al 31 de diciembre de este año",
    );

    expect(result.intent).toBe("availability_request");
    expect(result.slots.petName).toBe("Toby");
    expect(result.matchedSignals).toContain("availability_slot_filling");
  });

  it("answers general information without sending the conversation to human mode", () => {
    const { plan, reply } = buildRenderedPlan("Hola, quiero información");

    expect(plan.intent).toBe("general_information");
    expect(plan.handoff).toBe(false);
    expect(reply).toContain("¡Hola! Claro");
    expect(reply).toContain("horarios");
    expect(reply).toContain("visitas");
    expect(reply).not.toContain("Ese caso prefiero");
    expect(reply).not.toContain("por aqui");
  });

  it("answers open hotel info from the quality KB path", () => {
    const { plan, reply } = buildRenderedPlan("Buenos días, me gustaría saber más sobre el hotel");

    expect(plan.intent).toBe("general_info_query");
    expect(plan.renderKey).toBe("conversation.general_hotel_info");
    expect(plan.handoff).toBe(false);
    expect(reply).toContain("Somos Muy Perros");
    expect(reply).toContain("servicios");
    expect(reply).not.toContain("Gracias, revisamos");
    expect(reply).not.toContain("Perdona, no te he entendido");
  });

  it("holds reservation intent while answering prior info questions", () => {
    const { plan, reply } = buildRenderedPlan(
      "Quiero hacer una reserva pero me gustaría saber antes algunas cosas",
    );

    expect(plan.intent).toBe("mixed_reservation_and_info");
    expect(plan.slots.wantsToReserve).toBe(true);
    expect(plan.slots.wantsInfoBeforeReserve).toBe(true);
    expect(plan.handoff).toBe(false);
    expect(reply).toContain("dime qué quieres saber");
    expect(reply).toContain("después seguimos con la reserva");
  });

  it.each([
    ["este finde", "este_fin_de_semana"],
    ["este fin de semana", "este_fin_de_semana"],
    ["el próximo finde", "proximo_fin_de_semana"],
    ["sábado y domingo", "sabado_domingo"],
  ])("classifies informal availability for %s", (phrase, relativeDateRange) => {
    const { plan, reply } = buildRenderedPlan(`Buenos días, tenéis disponibilidad para ${phrase}?`);

    expect(plan.intent).toBe("informal_availability_query");
    expect(plan.slots.relativeDateRange).toBe(relativeDateRange);
    expect(plan.handoff).toBe(false);
    expect(reply).toContain("No te confirmo plaza");
    expect(reply).not.toContain("Gracias, revisamos");
  });

  it("answers pure greetings with a short natural reply", () => {
    const { plan, reply } = buildRenderedPlan("Buenos días");

    expect(plan.intent).toBe("greeting");
    expect(plan.handoff).toBe(false);
    expect(reply).toBe("Buenos días. ¿En qué podemos ayudarte?");
    expect(reply).toContain("¿En qué podemos ayudarte?");
    expect(reply).not.toContain("horarios");
    expect(reply).not.toContain("visitas");
  });

  it.each([
    ["hola", "¡Hola! ¿En qué podemos ayudarte?"],
    ["hola!", "¡Hola! ¿En qué podemos ayudarte?"],
    ["buenos días", "Buenos días. ¿En qué podemos ayudarte?"],
    ["hola buenos días", "Buenos días. ¿En qué podemos ayudarte?"],
    ["buenas tardes", "Buenas tardes. ¿En qué podemos ayudarte?"],
    ["hola buenas tardes", "Buenas tardes. ¿En qué podemos ayudarte?"],
    ["buenas noches", "Buenas noches. ¿En qué podemos ayudarte?"],
    ["hola buenas noches", "Buenas noches. ¿En qué podemos ayudarte?"],
    ["hola, qué tal", "¡Hola! ¿En qué podemos ayudarte?"],
  ])("keeps pure greeting %s out of FAQ routing", (message, expectedReply) => {
    const { plan, reply } = buildRenderedPlan(message);

    expect(isPureGreeting(message)).toBe(true);
    expect(plan.intent).toBe("greeting");
    expect(plan.source).toBe("conversation_nlu");
    expect(reply).toBe(expectedReply);
    expect(reply).not.toContain("horario de recepción");
    expect(reply).not.toContain("8:00");
  });

  it.each([
    ["buenas tardes, quiero reservar", "reservation_start", "Buenas tardes. Te ayudo"],
    ["hola buenas, quiero hacer una reserva", "reservation_start", "Buenas. Te ayudo"],
    ["buenas tardes, ¿a qué hora puedo recogerlo?", "faq_hours", "El horario de recepción"],
  ] as const)("keeps greeting prefixes but routes explicit intent: %s", (message, intent, expectedReply) => {
    const { plan, reply } = buildRenderedPlan(message);

    expect(plan.intent).toBe(intent);
    expect(reply).toContain(expectedReply);
  });

  it("keeps social greeting prefixes in routed replies", () => {
    expect(renderPlan("En primer lugar, buenos días")).toBe(
      "Buenos días. ¿En qué podemos ayudarte?",
    );
    expect(renderPlan("Hola, quiero hacer una reserva")).toBe(
      "¡Hola! Te ayudo con la reserva. Dime, por favor, la fecha de entrada, la fecha de salida y el nombre de tu mascota.",
    );
    expect(renderPlan("Buenos días, quiero consultar disponibilidad")).toBe(
      "Buenos días. Para consultar disponibilidad, dime la fecha de entrada, la fecha de salida y el nombre de tu mascota.",
    );
    expect(renderPlan("Buenas, quiero información")).toContain(
      "Buenas. Claro. Te puedo ayudar",
    );
  });

  it("answers reset with a compact operational reply", () => {
    const { plan, reply } = buildRenderedPlan("reiniciar");

    expect(plan.intent).toBe("conversation_reset");
    expect(reply).toBe("Reiniciado.");
    expect(reply).not.toContain("información general");
  });

  it("extracts price quote slots without turning a plain price FAQ into a flow", () => {
    const quoteMessage = "Hola! Querría saber el precio desde 30 junio hasta 8 julio";
    const directMessage = "quería saber que me cuesta deja a mi perro del 30 de junio al 8 de julio";
    const { plan: quote, reply: quoteReply } = buildRenderedPlan(quoteMessage);
    const { plan: direct, reply: directReply } = buildRenderedPlan(directMessage);
    const plainFaq = buildConversationReplyPlan("¿cuánto cuesta?");

    expect(quote.intent).toBe("price_quote");
    expect(quote.slots.checkInDate).toBe("2027-06-30");
    expect(quote.slots.checkOutDate).toBe("2027-07-08");
    expect(quoteReply).toContain("necesito saber cuántos perros");
    expect(quoteReply).not.toContain("Perdona, no te he entendido bien");
    expect(direct.intent).toBe("price_quote");
    expect(direct.slots.petCount).toBe(1);
    expect(directReply).toContain("240 €");
    expect(plainFaq.intent).toBe("faq_prices");
  });

  it("treats breed mentions as breed slots, not pet names", () => {
    const result = classifyConversationIntent("Si una residencia para un Rottweiler");

    expect(result.intent).toBe("availability_request");
    expect(result.slots.petCount).toBe(1);
    expect(result.slots.petBreeds).toEqual(["Rottweiler"]);
    expect(result.slots.petName).toBeUndefined();
    expect(result.matchedSignals).toContain("breed_detected");
  });

  it.each([
    "hasta principios de septiembre",
    "hasta mediados de agosto",
    "hasta finales de julio",
    "la semana que viene",
    "unos días en agosto",
  ])("marks vague date phrase %s as needing exact date", (message) => {
    const result = classifyConversationIntent(`residencia para un labrador ${message}`);

    expect(result.intent).toBe("availability_request");
    expect(result.slots.needsExactDate).toBe(true);
    expect(result.slots.vagueDateMention).toBeDefined();
  });

  it.each([
    ["¿y el pago?", "faq_payment", "El pago se hace a la llegada"],
    ["¿cómo se paga?", "faq_payment", "Bizum"],
    ["¿puedo pagar por bizum?", "faq_payment", "transferencia"],
    ["¿hay que dejar señal?", "faq_payment", "La señal no es obligatoria"],
    ["¿cuándo puedo dejar al perro?", "faq_hours", "El horario de recepción"],
    ["¿cuál es el horario?", "faq_hours", "El horario de recepción"],
    ["horario de recepción", "faq_hours", "El horario de recepción"],
    ["¿puedo recogerlo por la tarde?", "faq_hours", "El horario de recepción"],
    ["¿puedo visitar el hotel?", "faq_visits", "lunes a jueves"],
    ["¿cuánto cuesta?", "faq_prices", "Las tarifas 2026"],
    ["¿me mandáis vídeos?", "faq_photos_videos", "Durante la estancia"],
    ["¿puedo llevar su comida?", "faq_food", "alimentación especial"],
    ["¿qué vacunas necesita?", "faq_vaccines", "requisitos de alojamiento"],
    ["¿dónde estáis?", "faq_location", "Camino de Santiago, 58"],
    ["¿hay peluquería?", "faq_services", "servicios complementarios"],
  ] as const)("answers shared WhatsApp FAQ %s", (message, intent, expectedCopy) => {
    const { plan, reply } = buildRenderedPlan(message);

    expect(plan.intent).toBe(intent);
    expect(plan.source).toBe("faq_public_chat");
    expect(plan.handoff).toBe(false);
    expect(reply).toContain(expectedCopy);
    expect(reply).not.toContain("Perdona, no te he entendido bien");
  });

  it("routes reservation changes to the operational modification flow", () => {
    const { plan, reply } = buildRenderedPlan("quiero cambiar la reserva");

    expect(plan.intent).toBe("reservation_modify");
    expect(plan.source).toBe("conversation_nlu");
    expect(plan.handoff).toBe(false);
    expect(reply).toContain("Te ayudo a modificarla");
  });

  it("uses the covered-question fallback for concrete unknown questions", () => {
    const { plan, reply } = buildRenderedPlan("¿y el unicornio?");

    expect(plan.intent).toBe("human_handoff");
    expect(plan.source).toBe("faq_public_chat");
    expect(plan.handoff).toBe(true);
    expect(reply).toBe(
      "Disculpa, para esta información un miembro de nuestro equipo se pondrá en contacto contigo para aclarar esta cuestión.",
    );
  });

  it("extracts pet name from explicit name phrasing without keeping connector words", () => {
    const result = classifyConversationIntent(
      "El nombre de mi mascota es YUYU, y quiero del 30 al 31 de Diciembre",
    );

    expect(result.intent).toBe("availability_request");
    expect(result.slots.petName).toBe("YUYU");
    expect(result.slots.petName).not.toBe("es YUYU");
  });

  it("does not invent live stay status", () => {
    const { plan, reply } = buildRenderedPlan("¿Ha comido mi perro?");

    expect(plan.intent).toBe("stay_status_question");
    expect(plan.handoff).toBe(true);
    expect(reply).toContain("respuesta real");
    expect(reply).toContain("persona del equipo");
  });

  it("asks for clarification on unknown messages without aggressive fallback", () => {
    const { plan, reply } = buildRenderedPlan("xyz abc");

    expect(plan.intent).toBe("unknown");
    expect(plan.handoff).toBe(false);
    expect(reply).toContain("Perdona, no te he entendido bien");
    expect(reply).not.toContain("Ese caso prefiero");
  });

  it.each([
    ["reiniciar", "conversation_reset"],
    ["/reiniciar", "conversation_reset"],
    ["reset", "conversation_reset"],
    ["/reset", "conversation_reset"],
    ["empezar de nuevo", "conversation_reset"],
    ["limpiar conversación", "conversation_reset"],
    ["quiero cancelar mi reserva", "reservation_cancel"],
    ["necesito anular la reserva", "reservation_cancel"],
    ["cancelación de reserva", "reservation_cancel"],
    ["quiero cambiar la reserva", "reservation_modify"],
    ["necesito modificar fechas", "reservation_modify"],
    ["puedo cambiar la hora", "reservation_modify"],
    ["¿y el pago?", "faq_payment"],
    ["¿cómo se paga?", "faq_payment"],
    ["¿hay que dejar señal?", "faq_payment"],
    ["diferencia entre hotel y guardería", "faq_services"],
    ["hotel y guardería", "faq_services"],
    ["¿qué vacunas necesita?", "faq_vaccines"],
    ["¿puedo visitar el hotel?", "faq_visits"],
    ["¿dónde estáis?", "faq_location"],
    ["está bien", "reservation_confirm"],
    ["de acuerdo", "reservation_confirm"],
    ["acepto", "reservation_confirm"],
    ["confirmo la reserva", "reservation_confirm"],
    ["anótala por favor", "reservation_confirm"],
    ["quiero reservar", "reservation_start"],
    ["necesito reservar", "reservation_start"],
    ["quisiera reservar para mi perro", "reservation_start"],
    ["hay plaza para mi perro", "availability_request"],
    ["tenéis sitio para un Rottweiler", "availability_request"],
  ] as const)("routes fuzz phrase %s as %s", (message, expectedIntent) => {
    const { plan, reply } = buildRenderedPlan(message);

    expect(plan.intent).toBe(expectedIntent);
    expect(reply).not.toBe("Gracias. Ahora dime la fecha y hora de entrada, y la fecha y hora de salida.");
  });

  it("keeps NLU plans structured without visible reply fields", () => {
    const plan = buildConversationReplyPlan("¿y el pago?");

    expect(plan).toMatchObject({
      intent: "faq_payment",
      renderKey: "conversation.faq_reply",
      source: "faq_public_chat",
    });
    for (const forbidden of ["reply", "replyText", "message", "botReply", "visibleText"]) {
      expect(Object.prototype.hasOwnProperty.call(plan, forbidden)).toBe(false);
    }
  });
});

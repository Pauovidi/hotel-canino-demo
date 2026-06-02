import { describe, expect, it } from "vitest";
import {
  buildConversationReplyPlan,
  classifyConversationIntent,
  isAffirmativeConfirmationUtterance,
} from "./nlu";

describe("conversation NLU", () => {
  it.each([
    ["Hola", "greeting"],
    ["hola buenos días", "greeting"],
    ["Hola, buenos días", "greeting"],
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
    ["¿Qué tengo que llevar?", "faq_what_to_bring"],
    ["¿Puedo visitar el hotel?", "faq_visits"],
    ["¿Qué vacunas necesita?", "faq_vaccines"],
    ["¿Mandáis fotos o vídeos?", "faq_photos_videos"],
    ["¿Tenéis sitio del 14 al 18 de abril?", "availability_request"],
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
    ["empezar de nuevo", "conversation_reset"],
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
    const plan = buildConversationReplyPlan("Hola, quiero información");

    expect(plan.intent).toBe("general_information");
    expect(plan.handoff).toBe(false);
    expect(plan.reply).toContain("¡Hola! Claro");
    expect(plan.reply).toContain("horarios");
    expect(plan.reply).toContain("visitas");
    expect(plan.reply).not.toContain("Ese caso prefiero");
    expect(plan.reply).not.toContain("por aqui");
  });

  it("answers pure greetings with a short natural reply", () => {
    const plan = buildConversationReplyPlan("Buenos días");

    expect(plan.intent).toBe("greeting");
    expect(plan.handoff).toBe(false);
    expect(plan.reply).toBe("Buenos días. ¿En qué podemos ayudarte?");
    expect(plan.reply).toContain("¿En qué podemos ayudarte?");
    expect(plan.reply).not.toContain("horarios");
    expect(plan.reply).not.toContain("visitas");
  });

  it("keeps social greeting prefixes in routed replies", () => {
    expect(buildConversationReplyPlan("En primer lugar, buenos días").reply).toBe(
      "Buenos días. ¿En qué podemos ayudarte?",
    );
    expect(buildConversationReplyPlan("Hola, quiero hacer una reserva").reply).toBe(
      "¡Hola! Te ayudo con la reserva. Dime, por favor, la fecha de entrada, la fecha de salida y el nombre de tu mascota.",
    );
    expect(buildConversationReplyPlan("Buenos días, quiero consultar disponibilidad").reply).toBe(
      "Buenos días. Para consultar disponibilidad, dime la fecha de entrada, la fecha de salida y el nombre de tu mascota.",
    );
    expect(buildConversationReplyPlan("Buenas, quiero información").reply).toContain(
      "Buenas. Claro. Te puedo ayudar",
    );
  });

  it("answers reset with a compact operational reply", () => {
    const plan = buildConversationReplyPlan("reiniciar");

    expect(plan.intent).toBe("conversation_reset");
    expect(plan.reply).toBe("Reiniciado.");
    expect(plan.reply).not.toContain("información general");
  });

  it.each([
    ["¿y el pago?", "faq_payment", "El pago se hace a la llegada"],
    ["¿cómo se paga?", "faq_payment", "Bizum"],
    ["¿puedo pagar por bizum?", "faq_payment", "transferencia"],
    ["¿hay que dejar señal?", "faq_payment", "La señal no es obligatoria"],
    ["¿cuándo puedo dejar al perro?", "faq_hours", "El horario de recepción"],
    ["¿puedo visitar el hotel?", "faq_visits", "lunes a jueves"],
    ["¿cuánto cuesta?", "faq_prices", "Las tarifas 2026"],
    ["¿me mandáis vídeos?", "faq_photos_videos", "Durante la estancia"],
    ["¿puedo llevar su comida?", "faq_food", "alimentación especial"],
    ["¿qué vacunas necesita?", "faq_vaccines", "requisitos de alojamiento"],
    ["¿dónde estáis?", "faq_location", "Camino de Santiago, 58"],
    ["¿hay peluquería?", "faq_services", "servicios complementarios"],
    ["quiero cambiar la reserva", "faq_cancellation", "cambios o cancelaciones"],
  ] as const)("answers shared WhatsApp FAQ %s", (message, intent, expectedCopy) => {
    const plan = buildConversationReplyPlan(message);

    expect(plan.intent).toBe(intent);
    expect(plan.source).toBe("faq_public_chat");
    expect(plan.handoff).toBe(false);
    expect(plan.reply).toContain(expectedCopy);
    expect(plan.reply).not.toContain("Perdona, no te he entendido bien");
  });

  it("uses the covered-question fallback for concrete unknown questions", () => {
    const plan = buildConversationReplyPlan("¿y el unicornio?");

    expect(plan.intent).toBe("human_handoff");
    expect(plan.source).toBe("faq_public_chat");
    expect(plan.handoff).toBe(true);
    expect(plan.reply).toBe(
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
    const plan = buildConversationReplyPlan("¿Ha comido mi perro?");

    expect(plan.intent).toBe("stay_status_question");
    expect(plan.handoff).toBe(true);
    expect(plan.reply).toContain("respuesta real");
    expect(plan.reply).toContain("persona del equipo");
  });

  it("asks for clarification on unknown messages without aggressive fallback", () => {
    const plan = buildConversationReplyPlan("xyz abc");

    expect(plan.intent).toBe("unknown");
    expect(plan.handoff).toBe(false);
    expect(plan.reply).toContain("Perdona, no te he entendido bien");
    expect(plan.reply).not.toContain("Ese caso prefiero");
  });
});

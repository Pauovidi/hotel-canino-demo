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
    ["buenas tardes, quería información", "general_information"],
    ["hola, quería información", "general_information"],
    ["Hola, quiero información", "general_information"],
    ["¿Qué tengo que llevar?", "faq_what_to_bring"],
    ["¿Puedo visitar el hotel?", "faq_visits"],
    ["¿Qué vacunas necesita?", "faq_vaccines"],
    ["¿Mandáis fotos o vídeos?", "faq_photos_videos"],
    ["¿Tenéis sitio del 14 al 18 de abril?", "availability_request"],
    ["quiero hacer una reserva", "reservation_start"],
    ["Buenos días quiero hacer una reserva", "reservation_start"],
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
    expect(plan.reply).toContain("horarios");
    expect(plan.reply).toContain("visitas");
    expect(plan.reply).not.toContain("Ese caso prefiero");
    expect(plan.reply).not.toContain("por aqui");
  });

  it("answers pure greetings with a short natural reply", () => {
    const plan = buildConversationReplyPlan("Buenos días");

    expect(plan.intent).toBe("greeting");
    expect(plan.handoff).toBe(false);
    expect(plan.reply).toContain("¿En qué podemos ayudarte?");
    expect(plan.reply).not.toContain("horarios");
    expect(plan.reply).not.toContain("visitas");
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
    expect(plan.reply).toContain("¿Quieres información general");
    expect(plan.reply).not.toContain("Ese caso prefiero");
  });
});

import { describe, expect, it } from "vitest";

import { buildTemplatePreviewResult } from "./template-preview";
import type { ConversationRecord } from "./types";

function conversation(): ConversationRecord {
  return {
    id: "conv_preview",
    phoneE164: "+34600000000",
    phoneNormalized: "34600000000",
    displayName: "Pau",
    sourceType: "whatsapp",
    mode: "bot",
    humanRequested: false,
    unreadCount: 0,
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:00:00.000Z",
    messages: [],
    events: [],
  };
}

describe("template preview commands", () => {
  it("renders confirmation preview without the removed header", () => {
    const result = buildTemplatePreviewResult(
      "muéstrame la plantilla de confirmación",
      conversation(),
      { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    );

    expect(result?.reply).toContain("Vista previa de plantilla: confirmación");
    expect(result?.reply).toContain("*Hola* Pau");
    expect(result?.reply).toContain("El coste de la estancia es de *30€*");
    expect(result?.reply).not.toContain("ATENCIÓN LEER HASTA EL FINAL");
  });

  it.each([
    ["plantilla recordatorio", "Le recordamos que tiene una reserva"],
    ["plantilla feedback", "después de su estancia con nosotros"],
    ["plantilla post estancia", "después de su estancia con nosotros"],
    ["plantilla reseña", "https://g.page/r/CbNKrJ36PLSeEBE/review"],
    ["plantilla baño", "15€ para perros pequeños"],
    ["plantilla denegación", "no tenemos disponibilidad"],
  ])("renders %s", (command, expected) => {
    const result = buildTemplatePreviewResult(
      command,
      conversation(),
      { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    );

    expect(result?.reply).toContain("Vista previa de plantilla:");
    expect(result?.reply).toContain(expected);
  });

  it("renders all templates", () => {
    const result = buildTemplatePreviewResult(
      "/preview templates",
      conversation(),
      { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    );

    expect(result?.kind).toBe("all");
    expect(result?.reply).toContain("--- confirmación ---");
    expect(result?.reply).toContain("--- recordatorio ---");
    expect(result?.reply).toContain("--- baño ---");
  });

  it("blocks preview in production when disabled and outside sandbox", () => {
    const result = buildTemplatePreviewResult(
      "plantilla confirmación",
      conversation(),
      { NODE_ENV: "production", TWILIO_WHATSAPP_PROVIDER_MODE: "real" } as NodeJS.ProcessEnv,
      {
        contractUrl: "https://somosmuyperros.com/contrato-de-admision-e-ingreso/",
        requireContractAcceptance: true,
        confirmationTemplateEnabled: true,
        reservationRemindersEnabled: false,
        postStayFollowupsEnabled: false,
        reminderDryRun: true,
        followupDryRun: true,
        postStayFollowupOnlyNewClients: true,
        welcomeDogPersonaEnabled: false,
        welcomeStickerDryRun: true,
        templatePreviewEnabled: false,
        templatePreviewAllowInSandbox: true,
        templatePreviewAdminOnly: true,
        templatePreviewSampleClientName: "Pau",
        templatePreviewSamplePets: ["PIPO"],
        templatePreviewSamplePrice: "30€",
        templatePreviewSampleEntry: "Viernes, 25 de Diciembre de 2026 a las 10:00",
        templatePreviewSampleExit: "Sábado, 26 de Diciembre de 2026 a las 10:00",
      },
    );

    expect(result?.kind).toBe("disabled");
    expect(result?.reply).toContain("pruebas internas");
  });
});

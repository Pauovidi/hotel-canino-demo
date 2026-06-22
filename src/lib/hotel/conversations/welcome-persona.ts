import { getClientRequestsConfig } from "./client-requests";
import type { ConversationRecord } from "./types";

export function buildWelcomeDogPersonaReply(name?: string): string {
  const greeting = name?.trim() ? `Hola, ${name.trim()}.` : "Hola.";
  return [
    greeting,
    "Soy el asistente de Somos Muy Perros. Puedo ayudarte con reservas, cambios, precios y dudas del hotel.",
  ].join(" ");
}

export function buildWelcomeStickerDryRunEvent(
  conversation: Pick<ConversationRecord, "id" | "events">,
) {
  const config = getClientRequestsConfig();
  if (!config.welcomeDogPersonaEnabled || !config.welcomeStickerMediaUrl) {
    return undefined;
  }

  const alreadyPlanned = conversation.events.some(
    (event) => event.eventType === "welcome_sticker_dry_run_planned",
  );
  if (alreadyPlanned) {
    return undefined;
  }

  return {
    conversationId: conversation.id,
    eventType: "welcome_sticker_dry_run_planned",
    payload: {
      dryRun: config.welcomeStickerDryRun,
      mediaUrlConfigured: true,
    },
  };
}

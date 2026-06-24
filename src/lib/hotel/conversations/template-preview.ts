import {
  getClientRequestsConfig,
  type ClientRequestsConfig,
} from "./client-requests";
import {
  renderBathOfferTemplate,
  renderPositiveReviewRequestTemplate,
  renderPostStayFollowupTemplate,
  renderPrearrivalReminderTemplate,
  renderReservationConfirmationTemplate,
  renderReservationDeniedTemplate,
  renderReservationWelcomeIntroTemplate,
  reservationTemplateInputFromProposal,
  type ReservationTemplateInput,
} from "./client-templates";
import type { ConversationRecord } from "./types";

export type TemplatePreviewKind =
  | "confirmation"
  | "reminder"
  | "post_stay"
  | "positive_review"
  | "bath"
  | "denial"
  | "welcome";

export interface TemplatePreviewResult {
  kind: TemplatePreviewKind | "all" | "disabled";
  reply: string;
  eventPayload: Record<string, unknown>;
}

const TEMPLATE_ORDER: TemplatePreviewKind[] = [
  "confirmation",
  "reminder",
  "post_stay",
  "positive_review",
  "bath",
  "denial",
  "welcome",
];

const TEMPLATE_LABELS: Record<TemplatePreviewKind, string> = {
  confirmation: "confirmación",
  reminder: "recordatorio",
  post_stay: "post-estancia",
  positive_review: "reseña",
  bath: "baño",
  denial: "denegación",
  welcome: "bienvenida/pre-confirmación",
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTemplateKind(message: string): TemplatePreviewKind | "all" | undefined {
  const normalized = normalize(message);
  const looksLikePreview =
    normalized.startsWith("/preview") ||
    normalized.includes("plantilla") ||
    normalized.includes("templates");
  if (!looksLikePreview) {
    return undefined;
  }

  if (/\b(?:todas|todos|templates)\b/.test(normalized)) {
    return "all";
  }
  if (/\b(?:confirmacion|confirmar|reserva confirmada)\b/.test(normalized)) {
    return "confirmation";
  }
  if (/\b(?:recordatorio|reminder)\b/.test(normalized)) {
    return "reminder";
  }
  if (/\b(?:feedback|post estancia|post-estancia|postestancia)\b/.test(normalized)) {
    return "post_stay";
  }
  if (/\b(?:resena|review)\b/.test(normalized)) {
    return "positive_review";
  }
  if (/\b(?:bano|banar|bañar)\b/.test(normalized)) {
    return "bath";
  }
  if (/\b(?:denegacion|denegada|no disponibilidad|sin disponibilidad)\b/.test(normalized)) {
    return "denial";
  }
  if (/\b(?:bienvenida|pre confirmacion|pre-confirmacion)\b/.test(normalized)) {
    return "welcome";
  }

  return undefined;
}

function isSandboxEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    env.TWILIO_WHATSAPP_PROVIDER_MODE?.trim().toLowerCase() === "sandbox" ||
    env.HOTEL_WHATSAPP_PROVIDER_MODE?.trim().toLowerCase() === "sandbox"
  );
}

function isPreviewAllowed(
  config: ClientRequestsConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (config.templatePreviewEnabled) {
    return true;
  }

  if (env.NODE_ENV === "test" || env.NODE_ENV === "development" || env.APP_ENV === "development") {
    return true;
  }

  return config.templatePreviewAllowInSandbox && isSandboxEnvironment(env);
}

function sampleConfirmationInput(
  conversation: ConversationRecord,
  config: ClientRequestsConfig,
): ReservationTemplateInput {
  const proposal = conversation.pendingReservationProposal;
  if (proposal) {
    return reservationTemplateInputFromProposal(proposal);
  }

  return {
    clientName: config.templatePreviewSampleClientName,
    petNames: config.templatePreviewSamplePets,
    checkIn: "2026-12-25",
    checkOut: "2026-12-26",
    checkInTime: "10:00",
    checkOutTime: "10:00",
    entryText: config.templatePreviewSampleEntry,
    exitText: config.templatePreviewSampleExit,
    priceText: config.templatePreviewSamplePrice,
  };
}

function samplePetNames(
  conversation: ConversationRecord,
  config: ClientRequestsConfig,
): string[] {
  const proposal = conversation.pendingReservationProposal;
  if (proposal?.petNames?.length) {
    return proposal.petNames;
  }
  if (proposal?.petName) {
    return [proposal.petName];
  }
  if (conversation.clientPets?.length) {
    return conversation.clientPets;
  }
  return config.templatePreviewSamplePets;
}

function sampleClientName(
  conversation: ConversationRecord,
  config: ClientRequestsConfig,
): string {
  return (
    conversation.pendingReservationProposal?.ownerName ??
    conversation.pendingReservationProposal?.clientName ??
    conversation.clientName ??
    conversation.customerName ??
    conversation.displayName ??
    config.templatePreviewSampleClientName
  );
}

function renderTemplate(
  kind: TemplatePreviewKind,
  conversation: ConversationRecord,
  config: ClientRequestsConfig,
): string {
  const petNames = samplePetNames(conversation, config);
  const clientName = sampleClientName(conversation, config);

  switch (kind) {
    case "confirmation":
      return renderReservationConfirmationTemplate(sampleConfirmationInput(conversation, config));
    case "reminder":
      return renderPrearrivalReminderTemplate({
        clientName,
        petNames,
        entryText: config.templatePreviewSampleEntry,
      });
    case "post_stay":
      return renderPostStayFollowupTemplate({ clientName, petNames });
    case "positive_review":
      return renderPositiveReviewRequestTemplate();
    case "bath":
      return renderBathOfferTemplate();
    case "denial":
      return renderReservationDeniedTemplate({
        clientName,
        petNames,
        waitlistSupported: false,
      });
    case "welcome":
      return renderReservationWelcomeIntroTemplate({ clientName, petNames });
  }
}

function renderPreviewReply(
  kind: TemplatePreviewKind | "all",
  conversation: ConversationRecord,
  config: ClientRequestsConfig,
): string {
  if (kind === "all") {
    return [
      "Vista previa de plantilla: todas",
      "",
      ...TEMPLATE_ORDER.flatMap((templateKind) => [
        `--- ${TEMPLATE_LABELS[templateKind]} ---`,
        renderTemplate(templateKind, conversation, config),
        "",
      ]),
    ].join("\n").trim();
  }

  return [
    `Vista previa de plantilla: ${TEMPLATE_LABELS[kind]}`,
    "",
    renderTemplate(kind, conversation, config),
  ].join("\n");
}

export function buildTemplatePreviewResult(
  message: string,
  conversation: ConversationRecord,
  env: NodeJS.ProcessEnv = process.env,
  config = getClientRequestsConfig(),
): TemplatePreviewResult | undefined {
  const kind = detectTemplateKind(message);
  if (!kind) {
    return undefined;
  }

  if (!isPreviewAllowed(config, env)) {
    return {
      kind: "disabled",
      reply: "Esta función está disponible solo para pruebas internas.",
      eventPayload: {
        enabled: false,
        requestedTemplate: kind,
      },
    };
  }

  return {
    kind,
    reply: renderPreviewReply(kind, conversation, config),
    eventPayload: {
      enabled: true,
      template: kind,
      source: "template_preview_command",
    },
  };
}

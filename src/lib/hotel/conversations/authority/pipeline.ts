import type { ConversationReplyPlan } from "../nlu";
import { isConversationResetCommand } from "../nlu";
import { decideConversationPolicy } from "../policy/policy-engine";
import {
  computeMissingReservationFields,
  extractReservationSlotsFromMessage,
  resolveReservationSlotTarget,
} from "../reservation-flow";
import type { ConversationRecord, ConversationReservationFlow } from "../types";
import type {
  ConversationAction,
  NormalizedUserEvent,
  OutboxMessage,
  RenderedConversationReply,
  StructuredConversationInterpretation,
  ToolResultSummary,
} from "./types";

export interface NormalizeWhatsAppEventInput {
  from: string;
  to?: string;
  body: string;
  messageSid?: string;
  displayName?: string;
  rawPayload?: unknown;
  conversation?: ConversationRecord;
  source?: NormalizedUserEvent["source"];
  now?: Date;
}

function lastBotReply(record?: ConversationRecord): string | undefined {
  return [...(record?.messages ?? [])]
    .reverse()
    .find((message) => message.direction === "outbound" && message.senderType === "bot")?.body;
}

function inferLastBotQuestionKind(reply?: string): string | undefined {
  if (!reply) return undefined;
  const normalized = reply
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (normalized.includes("salida")) return "ask_exit_date_time";
  if (normalized.includes("entrada")) return "ask_entry_date_time";
  if (normalized.includes("mascota")) return "ask_pet";
  if (normalized.includes("email")) return "ask_owner_or_email";
  if (normalized.includes("observacion") || normalized.includes("medicacion")) return "ask_notes";
  if (normalized.includes("visitar")) return "ask_visit";
  return undefined;
}

function currentStateFromConversation(record?: ConversationRecord): NormalizedUserEvent["currentState"] {
  if (!record) return undefined;
  return {
    activeFlow: record.reservationFlow
      ? "reservation"
      : record.pendingReservationModificationFlow || record.pendingReservationCancellationFlow
        ? "reservation_change"
        : record.pendingPriceQuoteFlow
          ? "price_quote"
          : "none",
    reservationStatus: record.reservationFlow?.status,
    proposalStatus: record.pendingReservationProposal?.status,
    termsStatus: record.pendingReservationProposal?.termsAccepted
      ? "accepted"
      : record.pendingReservationProposal?.contractAcceptanceRequestedAt
        ? "requested"
        : undefined,
  };
}

function pendingFieldsFromConversation(record?: ConversationRecord): string[] {
  return record?.reservationFlow ? computeMissingReservationFields(record.reservationFlow) : [];
}

export function normalizeWhatsAppUserEvent(input: NormalizeWhatsAppEventInput): NormalizedUserEvent {
  const lastReply = lastBotReply(input.conversation);
  return {
    conversationId: input.conversation?.id,
    externalUserId: input.from,
    channel: "whatsapp",
    messageText: input.body.trim(),
    media: [],
    timestamp: (input.now ?? new Date()).toISOString(),
    currentMode: input.conversation?.mode,
    currentState: currentStateFromConversation(input.conversation),
    clientStatus: input.conversation?.clientStatus,
    lastBotAction: undefined,
    lastBotQuestionKind: inferLastBotQuestionKind(lastReply),
    pendingFields: pendingFieldsFromConversation(input.conversation),
    source: input.source ?? "webhook",
    metadata: {
      hasTo: Boolean(input.to),
      hasMessageSid: Boolean(input.messageSid),
      hasDisplayName: Boolean(input.displayName),
      hasRawPayload: Boolean(input.rawPayload),
    },
  };
}

function safeSlotNames(slots: Record<string, unknown>): string[] {
  return Object.entries(slots)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key]) => key);
}

export function buildStructuredInterpretation(input: {
  event: NormalizedUserEvent;
  replyPlan: Pick<ConversationReplyPlan, "intent" | "confidence" | "handoff" | "source">;
  reservationFlow?: ConversationReservationFlow;
  now?: Date;
}): StructuredConversationInterpretation {
  const deterministicSlots = extractReservationSlotsFromMessage(input.event.messageText, {
    flow: input.reservationFlow,
    now: input.now,
  });
  const slotRecord = { ...deterministicSlots };
  const hasNoSlots = safeSlotNames(slotRecord).length === 0;
  const target = input.reservationFlow
    ? resolveReservationSlotTarget(input.event.messageText, input.reservationFlow, { now: input.now })
    : undefined;
  const intent = input.replyPlan.intent;

  return {
    intent,
    globalIntent: isConversationResetCommand(input.event.messageText)
      ? "reset"
      : intent === "human_handoff"
        ? "handoff"
        : intent.startsWith("faq_")
          ? "faq"
          : undefined,
    domainIntent: intent.startsWith("reservation_") || intent === "availability_request"
      ? "reservation"
      : undefined,
    slots: slotRecord,
    targetSlots: { ...(target?.targetedSlots ?? deterministicSlots) },
    correction: undefined,
    cancellation: {
      requested: intent === "reservation_cancel",
      scope: intent === "reservation_cancel" ? "reservation" : undefined,
    },
    faqIntent: intent.startsWith("faq_") ? intent : undefined,
    handoffIntent: input.replyPlan.handoff ? intent : undefined,
    confidence: input.replyPlan.confidence,
    safety: {
      canWriteState: false,
      canRenderUserText: false,
      canCallTools: false,
      canConfirmReservation: false,
      rawUnsupported: hasNoSlots && intent === "unknown",
    },
    rawUnsupported: hasNoSlots && intent === "unknown",
  };
}

export function decideNextConversationAction(input: {
  event: NormalizedUserEvent;
  interpretation: StructuredConversationInterpretation;
  state?: ConversationRecord;
  toolResults?: ToolResultSummary[];
}): ConversationAction {
  const decision = decideConversationPolicy({
    intent: input.interpretation.intent,
    conversationMode: input.event.currentMode,
    hasPendingReservationProposal: Boolean(input.state?.pendingReservationProposal),
    hasActiveReservationFlow: Boolean(input.state?.reservationFlow),
    hasActiveChangeFlow: Boolean(
      input.state?.pendingReservationModificationFlow ||
        input.state?.pendingReservationCancellationFlow,
    ),
    clientStatus: input.event.clientStatus,
    isResetCommand: input.interpretation.globalIntent === "reset",
    source: undefined,
  });
  const failedTool = input.toolResults?.find((result) => !result.ok);

  if (!decision.allowBotReply) {
    return {
      kind: "suppress_reply",
      policyRoute: decision.route,
      requiresToolSuccess: decision.requiresToolSuccess,
      reason: decision.reason,
    };
  }
  if (failedTool && decision.requiresToolSuccess) {
    return {
      kind: "fallback_contextual",
      policyRoute: decision.route,
      requiresToolSuccess: true,
      reason: `tool_failed:${failedTool.toolName}`,
      toolName: failedTool.toolName,
    };
  }
  if (decision.route === "global_reset" || input.interpretation.globalIntent === "reset") {
    return { kind: "cancel_flow", policyRoute: decision.route, requiresToolSuccess: false, reason: decision.reason };
  }
  if (decision.route === "manual_review") {
    return { kind: "handoff_to_human", policyRoute: decision.route, requiresToolSuccess: false, reason: decision.reason };
  }
  if (decision.route === "faq") {
    return { kind: "answer_faq_then_resume", policyRoute: decision.route, requiresToolSuccess: false, reason: decision.reason };
  }
  if (decision.route === "reservation_confirmation") {
    return { kind: "confirm_reservation", policyRoute: decision.route, requiresToolSuccess: true, reason: decision.reason };
  }
  if (decision.route === "reservation_flow") {
    return {
      kind: input.event.pendingFields.length > 0 ? "ask_missing_slot" : "propose_reservation",
      policyRoute: decision.route,
      requiresToolSuccess: decision.requiresToolSuccess,
      reason: decision.reason,
      slotNames: input.event.pendingFields,
    };
  }
  return { kind: "fallback_contextual", policyRoute: decision.route, requiresToolSuccess: decision.requiresToolSuccess, reason: decision.reason };
}

export function renderConversationReply(input: {
  action: ConversationAction;
  legacyReply?: string;
}): RenderedConversationReply {
  if (input.legacyReply !== undefined) {
    return {
      body: input.legacyReply,
      copySource: "legacy_allowed_temporarily_with_guard",
      actionKind: input.action.kind,
    };
  }
  return {
    body: undefined,
    copySource: "copy_renderer",
    actionKind: input.action.kind,
  };
}

export function buildOutboxMessage(input: {
  event: NormalizedUserEvent;
  rendered: RenderedConversationReply;
}): OutboxMessage | undefined {
  if (!input.rendered.body) {
    return undefined;
  }
  return {
    channel: input.event.channel,
    externalUserId: input.event.externalUserId,
    body: input.rendered.body,
    actionKind: input.rendered.actionKind,
    source: "copy_renderer",
    metadata: {
      copySource: input.rendered.copySource,
    },
  };
}

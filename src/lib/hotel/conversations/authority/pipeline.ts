import type { ConversationReplyPlan } from "../nlu";
import { isConversationResetCommand } from "../nlu";
import { decideConversationPolicy } from "../policy/policy-engine";
import {
  computeMissingReservationFields,
  extractReservationSlotsFromMessage,
  mergeReservationSlots,
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
import { renderCopy } from "./copy-renderer";

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
        : record.availabilityInquiry || record.activeFlow === "availabilityInquiry"
          ? "availabilityInquiry"
          : record.activeFlow === "info"
            ? "info"
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
    return {
      type: "reset_conversation",
      kind: "cancel_flow",
      policyRoute: decision.route,
      requiresToolSuccess: false,
      reason: decision.reason,
      renderKey: "conversation.reset",
    };
  }
  if (decision.route === "manual_review") {
    return {
      type: "handoff_to_human",
      kind: "handoff_to_human",
      policyRoute: decision.route,
      requiresToolSuccess: false,
      reason: decision.reason,
      renderKey: "conversation.human_handoff",
    };
  }
  if (decision.route === "faq") {
    return {
      type: "answer_faq_then_resume",
      kind: "answer_faq_then_resume",
      policyRoute: decision.route,
      requiresToolSuccess: false,
      reason: decision.reason,
      renderKey: "conversation.faq_reply",
    };
  }
  if (decision.route === "knowledge_base") {
    return {
      type: "answer_kb_topic",
      kind: "answer_faq_then_resume",
      policyRoute: decision.route,
      requiresToolSuccess: false,
      reason: decision.reason,
      renderKey: input.interpretation.intent === "general_info_query"
        ? "conversation.general_hotel_info"
        : "conversation.kb_topic_answer",
    };
  }
  if (decision.route === "mixed_reservation_info") {
    return {
      type: "hold_reservation_intent_while_answering_info",
      kind: "answer_faq_then_resume",
      policyRoute: decision.route,
      requiresToolSuccess: false,
      reason: decision.reason,
      renderKey: "conversation.mixed_reservation_info_intro",
    };
  }
  if (decision.route === "availability_inquiry") {
    return {
      type: "collect_availability_minimum_details",
      kind: "ask_missing_slot",
      policyRoute: decision.route,
      requiresToolSuccess: false,
      reason: decision.reason,
      renderKey: "conversation.availability_informal_collect_details",
    };
  }
  if (decision.route === "reservation_confirmation") {
    return {
      type: "confirm_reservation",
      kind: "confirm_reservation",
      policyRoute: decision.route,
      requiresToolSuccess: true,
      reason: decision.reason,
      renderKey: "conversation.reservation_confirm",
    };
  }
  if (decision.route === "reservation_flow") {
    return {
      type: input.event.pendingFields.length > 0 ? "ask_missing_slot" : "propose_reservation",
      kind: input.event.pendingFields.length > 0 ? "ask_missing_slot" : "propose_reservation",
      policyRoute: decision.route,
      requiresToolSuccess: decision.requiresToolSuccess,
      reason: decision.reason,
      slotNames: input.event.pendingFields,
      renderKey: input.event.pendingFields.length > 0
        ? "reservation.ask_entry_exit_date_time"
        : "reservation.proposal",
    };
  }
  return {
    type: "fallback_contextual",
    kind: "fallback_contextual",
    policyRoute: decision.route,
    requiresToolSuccess: decision.requiresToolSuccess,
    reason: decision.reason,
    renderKey: "conversation.unknown",
  };
}

export function reduceReservationState(input: {
  state: ConversationReservationFlow;
  event: NormalizedUserEvent;
  interpretation: StructuredConversationInterpretation;
}): {
  flow: ConversationReservationFlow;
  stateChanged: boolean;
  appliedSlotNames: string[];
  ignoredSlotNames: string[];
  nextMissingFields: string[];
  staleProposalInvalidated: boolean;
  flowCancelled: boolean;
} {
  if (input.interpretation.cancellation?.requested) {
    return {
      flow: {
        ...input.state,
        status: "rejected",
        updatedAt: input.event.timestamp,
      },
      stateChanged: true,
      appliedSlotNames: [],
      ignoredSlotNames: Object.keys(input.interpretation.slots),
      nextMissingFields: [],
      staleProposalInvalidated: true,
      flowCancelled: true,
    };
  }

  const targetSlots = input.interpretation.targetSlots as Record<string, unknown>;
  const targetedReservationSlots = Object.fromEntries(
    Object.entries(targetSlots).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as Parameters<typeof mergeReservationSlots>[1];
  const reduced = mergeReservationSlots(input.state, targetedReservationSlots);
  const nextMissingFields = computeMissingReservationFields(reduced.flow);

  return {
    flow: {
      ...reduced.flow,
      updatedAt: input.event.timestamp,
    },
    stateChanged: reduced.appliedSlotNames.length > 0,
    appliedSlotNames: reduced.appliedSlotNames,
    ignoredSlotNames: Object.keys(input.interpretation.slots).filter(
      (slotName) => !reduced.appliedSlotNames.includes(slotName),
    ),
    nextMissingFields,
    staleProposalInvalidated: reduced.appliedSlotNames.some((slotName) =>
      ["checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "petName", "petCount"].includes(slotName),
    ),
    flowCancelled: false,
  };
}

export function decideReservationAction(input: {
  flow: ConversationReservationFlow;
  interpretation: StructuredConversationInterpretation;
  toolResults?: ToolResultSummary[];
}): ConversationAction {
  const failedTool = input.toolResults?.find((result) => !result.ok);
  if (failedTool) {
    return {
      type: "fallback_contextual",
      kind: "fallback_contextual",
      policyRoute: "fallback",
      requiresToolSuccess: true,
      reason: `tool_failed:${failedTool.toolName}`,
      toolName: failedTool.toolName,
      renderKey: "conversation.unknown",
    };
  }
  if (input.interpretation.globalIntent === "reset") {
    return {
      type: "reset_conversation",
      kind: "cancel_flow",
      policyRoute: "global_reset",
      requiresToolSuccess: false,
      reason: "global_reset",
      renderKey: "conversation.reset",
    };
  }
  if (input.interpretation.handoffIntent) {
    return {
      type: "handoff_to_human",
      kind: "handoff_to_human",
      policyRoute: "manual_review",
      requiresToolSuccess: false,
      reason: "handoff_intent",
      renderKey: "conversation.human_handoff",
    };
  }
  if (input.interpretation.faqIntent) {
    return {
      type: "answer_faq_then_resume",
      kind: "answer_faq_then_resume",
      policyRoute: "faq",
      requiresToolSuccess: false,
      reason: "faq_inside_reservation",
      renderKey: "conversation.faq_reply",
    };
  }
  if (input.interpretation.cancellation?.requested) {
    return {
      type: "cancel_reservation_flow",
      kind: "cancel_flow",
      policyRoute: "reservation_flow",
      requiresToolSuccess: false,
      reason: "reservation_cancel_requested",
      renderKey: "reservation.cancelled",
    };
  }

  const missing = computeMissingReservationFields(input.flow);
  if (missing.length > 0) {
    return {
      type: "ask_missing_slot",
      kind: "ask_missing_slot",
      policyRoute: "reservation_flow",
      requiresToolSuccess: false,
      reason: "missing_reservation_fields",
      slotNames: missing,
      renderKey: "reservation.ask_entry_exit_date_time",
      renderInput: { flow: input.flow },
    };
  }

  return {
    type: "propose_reservation",
    kind: "propose_reservation",
    policyRoute: "reservation_flow",
    requiresToolSuccess: true,
    reason: "reservation_ready_for_availability",
    toolName: "check_availability",
    renderKey: "reservation.proposal",
    renderInput: { flow: input.flow },
  };
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
  if (input.action.renderKey) {
    return {
      body: renderCopy({
        key: input.action.renderKey,
        ...input.action.renderInput,
      }),
      copySource: "copy_renderer",
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

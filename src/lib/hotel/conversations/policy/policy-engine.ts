import type { ConversationMode, ConversationRecord } from "../types";

export type ConversationPolicyRoute =
  | "global_reset"
  | "human_mode_suppressed"
  | "client_guardrail"
  | "reservation_confirmation"
  | "reservation_flow"
  | "reservation_change"
  | "price_quote"
  | "faq"
  | "media_request"
  | "manual_review"
  | "fallback";

export interface ConversationPolicyInput {
  intent: string;
  source?: string;
  conversationMode?: ConversationMode;
  hasPendingReservationProposal?: boolean;
  hasActiveReservationFlow?: boolean;
  hasActiveChangeFlow?: boolean;
  clientStatus?: ConversationRecord["clientStatus"];
  isResetCommand?: boolean;
}

export interface ConversationPolicyDecision {
  route: ConversationPolicyRoute;
  allowBotReply: boolean;
  requiresToolSuccess: boolean;
  reason: string;
}

export function decideConversationPolicy(
  input: ConversationPolicyInput,
): ConversationPolicyDecision {
  if (input.isResetCommand || input.intent === "conversation_reset") {
    return {
      route: "global_reset",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "reset_command_must_precede_stateful_guards",
    };
  }

  if (input.conversationMode === "human") {
    return {
      route: "human_mode_suppressed",
      allowBotReply: false,
      requiresToolSuccess: false,
      reason: "human_mode_blocks_automatic_replies",
    };
  }

  if (input.clientStatus === "blocked" || input.clientStatus === "ambiguous") {
    return {
      route: "client_guardrail",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "blocked_or_ambiguous_client_needs_human_review",
    };
  }

  if (input.intent === "reservation_confirm" || input.hasPendingReservationProposal) {
    return {
      route: "reservation_confirmation",
      allowBotReply: true,
      requiresToolSuccess: true,
      reason: "confirmation_copy_requires_successful_backend_write",
    };
  }

  if (input.hasActiveChangeFlow || input.intent === "reservation_modify" || input.intent === "reservation_cancel") {
    return {
      route: "reservation_change",
      allowBotReply: true,
      requiresToolSuccess: true,
      reason: "reservation_change_must_use_operational_change_flow",
    };
  }

  if (input.hasActiveReservationFlow || input.intent === "reservation_start") {
    return {
      route: "reservation_flow",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "reservation_details_are_collected_by_stateful_flow",
    };
  }

  if (input.intent === "price_quote") {
    return {
      route: "price_quote",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "deterministic_price_quote_copy",
    };
  }

  if (input.intent === "media_request") {
    return {
      route: "media_request",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "media_requests_must_not_fake_storage_or_delivery",
    };
  }

  if (input.source === "faq_public_chat" || input.intent.startsWith("faq_")) {
    return {
      route: "faq",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "faq_copy_renderer",
    };
  }

  if (input.intent === "human_handoff") {
    return {
      route: "manual_review",
      allowBotReply: true,
      requiresToolSuccess: false,
      reason: "manual_review_handoff",
    };
  }

  return {
    route: "fallback",
    allowBotReply: true,
    requiresToolSuccess: false,
    reason: "unknown_or_low_confidence_intent",
  };
}

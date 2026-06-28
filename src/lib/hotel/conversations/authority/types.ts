import type { ConversationPolicyRoute } from "../policy/policy-engine";
import type { ConversationMode, ConversationRecord } from "../types";
import type { ConversationRenderKey, RenderCopyInput } from "./copy-renderer";

export type ConversationChannel = "whatsapp" | "panel" | "job";
export type ConversationInboundSource = "webhook" | "panel" | "job" | "test";

export interface NormalizedUserEvent {
  conversationId?: string;
  externalUserId: string;
  channel: ConversationChannel;
  messageText: string;
  media: Array<{ kind: "image" | "video" | "audio" | "file"; contentType?: string }>;
  timestamp: string;
  currentMode?: ConversationMode;
  currentState?: {
    activeFlow?: "reservation" | "reservation_change" | "price_quote" | "none";
    reservationStatus?: string;
    proposalStatus?: string;
    termsStatus?: string;
  };
  clientStatus?: ConversationRecord["clientStatus"];
  lastBotAction?: string;
  lastBotQuestionKind?: string;
  pendingFields: string[];
  source: ConversationInboundSource;
  metadata: Record<string, unknown>;
}

export interface StructuredConversationInterpretation {
  intent: string;
  globalIntent?: string;
  domainIntent?: string;
  slots: Record<string, unknown>;
  targetSlots: Record<string, unknown>;
  correction?: { kind: string; slotNames: string[] };
  cancellation?: { requested: boolean; scope?: string };
  faqIntent?: string;
  handoffIntent?: string;
  confidence: "low" | "medium" | "high";
  safety: {
    canWriteState: false;
    canRenderUserText: false;
    canCallTools: false;
    canConfirmReservation: false;
    rawUnsupported?: boolean;
  };
  rawUnsupported?: boolean;
}

export interface ConversationStateReducerResult {
  stateChanged: boolean;
  appliedSlotNames: string[];
  ignoredSlotNames: string[];
  nextMissingFields: string[];
  staleProposalInvalidated: boolean;
  flowCancelled: boolean;
}

export type ConversationActionKind =
  | "ask_missing_slot"
  | "answer_faq_then_resume"
  | "cancel_flow"
  | "handoff_to_human"
  | "propose_reservation"
  | "request_contract_acceptance"
  | "confirm_reservation"
  | "render_template"
  | "call_tool"
  | "schedule_message"
  | "fallback_contextual"
  | "suppress_reply";

export interface ConversationAction {
  type?: string;
  kind: ConversationActionKind;
  policyRoute: ConversationPolicyRoute;
  requiresToolSuccess: boolean;
  reason: string;
  slotNames?: string[];
  toolName?: string;
  templateKind?: string;
  renderKey?: ConversationRenderKey;
  renderInput?: Omit<RenderCopyInput, "key">;
}

export interface ToolResultSummary {
  toolName: string;
  ok: boolean;
  dryRun?: boolean;
  safeErrorCode?: string;
}

export interface RenderedConversationReply {
  body?: string;
  copySource: "copy_renderer" | "legacy_allowed_temporarily_with_guard";
  actionKind: ConversationActionKind;
}

export interface OutboxMessage {
  channel: ConversationChannel;
  externalUserId: string;
  body?: string;
  actionKind: ConversationActionKind;
  source: "copy_renderer";
  metadata: Record<string, unknown>;
}

export interface AuthorityTurnTrace {
  turnId: string;
  conversationIdHash: string;
  channel: ConversationChannel;
  inboundKind: Record<string, unknown>;
  activeFlowBefore?: string;
  lastBotQuestionKindBefore?: string;
  pendingFieldsBefore: string[];
  nluCalled: boolean;
  nluProviderUsed: "openai" | "deterministic" | "skipped";
  nluIntent?: string;
  nluGlobalIntent?: string;
  nluSlotsExtracted: string[];
  nluTargetSlots: string[];
  slotsApplied: string[];
  slotsIgnored: Array<{ slotName: string; reason: string }>;
  statePatchSummary: {
    statusBefore?: string;
    statusAfter?: string;
    stateChanged: boolean;
  };
  pendingFieldsAfter: string[];
  activeFlowAfter?: string;
  policyAction?: string;
  policyReason?: string;
  renderKey?: ConversationRenderKey;
  outboxKind?: "twiml_response" | "manual_send" | "suppressed";
  legacyBypassUsed: boolean;
  legacyBypassName?: string;
  loopPrevented: boolean;
}

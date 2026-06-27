import { describe, expect, it } from "vitest";

import { buildConversationReplyPlan } from "../nlu";
import type { ConversationRecord, ConversationReservationFlow } from "../types";
import {
  buildOutboxMessage,
  buildStructuredInterpretation,
  decideReservationAction,
  decideNextConversationAction,
  normalizeWhatsAppUserEvent,
  reduceReservationState,
  renderConversationReply,
} from "./pipeline";

function makeFlow(overrides: Partial<ConversationReservationFlow> = {}): ConversationReservationFlow {
  return {
    flowId: "flow_test",
    status: "collecting_dates",
    clientKind: "new",
    ownerName: "QA Owner",
    email: "qa@example.test",
    petName: "PIPO",
    petNames: ["PIPO"],
    petCount: 1,
    createdAt: "2026-06-26T10:00:00.000Z",
    updatedAt: "2026-06-26T10:00:00.000Z",
    ...overrides,
  };
}

function makeConversation(flow = makeFlow()): ConversationRecord {
  return {
    id: "conv_test",
    phoneE164: "+34600009991",
    phoneNormalized: "34600009991",
    sourceType: "whatsapp",
    mode: "bot",
    humanRequested: false,
    unreadCount: 0,
    createdAt: "2026-06-26T10:00:00.000Z",
    updatedAt: "2026-06-26T10:00:00.000Z",
    clientStatus: "unknown",
    reservationFlow: flow,
    messages: [
      {
        id: "msg_bot",
        conversationId: "conv_test",
        direction: "outbound",
        senderType: "bot",
        transport: "whatsapp",
        body: "Perfecto, tengo la entrada. Que dia y a que hora seria la salida?",
        createdAt: "2026-06-26T10:01:00.000Z",
      },
    ],
    events: [],
  };
}

describe("conversation authority pipeline", () => {
  it("normalizes WhatsApp inbound with state context before reducers run", () => {
    const conversation = makeConversation(
      makeFlow({ checkInDate: "2026-06-27", checkInTime: "10:00" }),
    );
    const event = normalizeWhatsAppUserEvent({
      from: "whatsapp:+34600009991",
      to: "whatsapp:+14155238886",
      body: "lunes a las 10",
      messageSid: "SM_AUTH_001",
      conversation,
      now: new Date("2026-06-26T10:02:00.000Z"),
    });

    expect(event.channel).toBe("whatsapp");
    expect(event.currentState?.activeFlow).toBe("reservation");
    expect(event.lastBotQuestionKind).toBe("ask_exit_date_time");
    expect(event.pendingFields).toEqual(["check_out_date", "check_out_time"]);
    expect(event.metadata).toMatchObject({ hasMessageSid: true, hasTo: true });
  });

  it("keeps NLU structured and targets pending checkout without rendering copy", () => {
    const flow = makeFlow({ checkInDate: "2026-06-27", checkInTime: "10:00" });
    const conversation = makeConversation(flow);
    const event = normalizeWhatsAppUserEvent({
      from: "whatsapp:+34600009991",
      body: "lunes a las 10",
      conversation,
      now: new Date("2026-06-26T10:02:00.000Z"),
    });
    const interpretation = buildStructuredInterpretation({
      event,
      replyPlan: buildConversationReplyPlan(event.messageText),
      reservationFlow: flow,
      now: new Date("2026-06-26T10:02:00.000Z"),
    });

    expect(interpretation.targetSlots).toMatchObject({
      checkOutDate: "2026-06-29",
      checkOutTime: "10:00",
    });
    expect(interpretation.safety).toMatchObject({
      canWriteState: false,
      canRenderUserText: false,
      canCallTools: false,
      canConfirmReservation: false,
    });
    expect(Object.prototype.hasOwnProperty.call(interpretation, "reply")).toBe(false);
  });

  it("suppresses automatic replies in human mode at policy level", () => {
    const conversation = { ...makeConversation(), mode: "human" as const };
    const event = normalizeWhatsAppUserEvent({
      from: "whatsapp:+34600009991",
      body: "hola",
      conversation,
    });
    const interpretation = buildStructuredInterpretation({
      event,
      replyPlan: buildConversationReplyPlan(event.messageText),
      reservationFlow: conversation.reservationFlow,
    });
    const action = decideNextConversationAction({ event, interpretation, state: conversation });

    expect(action.kind).toBe("suppress_reply");
    expect(action.policyRoute).toBe("human_mode_suppressed");
  });

  it("marks legacy copy as temporary and sends only rendered outbox messages", () => {
    const event = normalizeWhatsAppUserEvent({
      from: "whatsapp:+34600009991",
      body: "hola",
    });
    const action = {
      kind: "fallback_contextual" as const,
      policyRoute: "fallback" as const,
      requiresToolSuccess: false,
      reason: "legacy_bridge",
    };
    const rendered = renderConversationReply({ action, legacyReply: "Hola QA" });
    const outbox = buildOutboxMessage({ event, rendered });

    expect(rendered.copySource).toBe("legacy_allowed_temporarily_with_guard");
    expect(outbox).toMatchObject({
      channel: "whatsapp",
      externalUserId: "whatsapp:+34600009991",
      body: "Hola QA",
      source: "copy_renderer",
    });
  });

  it("renders reset and reservation actions from CopyRenderer without legacy reply text", () => {
    const event = normalizeWhatsAppUserEvent({
      from: "whatsapp:+34600009991",
      body: "reiniciar",
    });
    const action = decideNextConversationAction({
      event,
      interpretation: {
        intent: "conversation_reset",
        globalIntent: "reset",
        slots: {},
        targetSlots: {},
        cancellation: { requested: false },
        confidence: "high",
        safety: {
          canWriteState: false,
          canRenderUserText: false,
          canCallTools: false,
          canConfirmReservation: false,
        },
      },
    });
    const rendered = renderConversationReply({ action });
    const outbox = buildOutboxMessage({ event, rendered });

    expect(action.renderKey).toBe("conversation.reset");
    expect(rendered).toMatchObject({
      body: "Reiniciado.",
      copySource: "copy_renderer",
    });
    expect(outbox?.body).toBe("Reiniciado.");
  });

  it("reduces reservation slots before policy chooses the next action", () => {
    const flow = makeFlow({ checkInDate: "2026-06-27", checkInTime: "10:00" });
    const conversation = makeConversation(flow);
    const event = normalizeWhatsAppUserEvent({
      from: "whatsapp:+34600009991",
      body: "lunes a las 10",
      conversation,
      now: new Date("2026-06-26T10:02:00.000Z"),
    });
    const interpretation = buildStructuredInterpretation({
      event,
      replyPlan: buildConversationReplyPlan(event.messageText),
      reservationFlow: flow,
      now: new Date("2026-06-26T10:02:00.000Z"),
    });
    const reduced = reduceReservationState({ state: flow, event, interpretation });
    const action = decideReservationAction({
      flow: reduced.flow,
      interpretation,
    });

    expect(reduced).toMatchObject({
      stateChanged: true,
      nextMissingFields: ["notes"],
    });
    expect(reduced.appliedSlotNames).toEqual(
      expect.arrayContaining(["checkOutDate", "checkOutTime"]),
    );
    expect(reduced.flow).toMatchObject({
      checkOutDate: "2026-06-29",
      checkOutTime: "10:00",
    });
    expect(action).toMatchObject({
      type: "ask_missing_slot",
      kind: "ask_missing_slot",
      renderKey: "reservation.ask_entry_exit_date_time",
    });
  });
});

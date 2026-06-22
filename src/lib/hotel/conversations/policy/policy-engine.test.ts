import { describe, expect, it } from "vitest";
import { decideConversationPolicy } from "./policy-engine";

describe("conversation policy shadow engine", () => {
  it("keeps reset above all stateful guards", () => {
    const decision = decideConversationPolicy({
      intent: "conversation_reset",
      conversationMode: "human",
      hasPendingReservationProposal: true,
      clientStatus: "blocked",
      isResetCommand: true,
    });

    expect(decision.route).toBe("global_reset");
    expect(decision.allowBotReply).toBe(true);
  });

  it("suppresses automatic replies in human mode", () => {
    const decision = decideConversationPolicy({
      intent: "faq_payment",
      conversationMode: "human",
    });

    expect(decision.route).toBe("human_mode_suppressed");
    expect(decision.allowBotReply).toBe(false);
  });

  it("requires backend success before reservation confirmation copy", () => {
    const decision = decideConversationPolicy({
      intent: "reservation_confirm",
      hasPendingReservationProposal: true,
    });

    expect(decision.route).toBe("reservation_confirmation");
    expect(decision.requiresToolSuccess).toBe(true);
  });

  it("guards blocked clients before reservation flow", () => {
    const decision = decideConversationPolicy({
      intent: "reservation_start",
      clientStatus: "blocked",
    });

    expect(decision.route).toBe("client_guardrail");
  });
});

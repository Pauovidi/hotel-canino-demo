import { describe, expect, it } from "vitest";

import {
  extractRelativeDateRange,
  listKnowledgeBaseGaps,
  matchConversationKnowledgeBase,
} from "./knowledge-base";

describe("conversation knowledge base", () => {
  it("matches open general hotel information without handoff", () => {
    const match = matchConversationKnowledgeBase("Buenos días, me gustaría saber más sobre el hotel");

    expect(match?.entry.id).toBe("general_hotel_info");
    expect(match?.entry.requiresHuman).toBe(false);
    expect(match?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(match?.answer).toContain("servicios");
  });

  it("recognizes informal availability and relative weekend ranges", () => {
    const range = extractRelativeDateRange("tenéis disponibilidad para este finde?");
    const match = matchConversationKnowledgeBase("tenéis disponibilidad para este finde?");

    expect(range).toMatchObject({ id: "este_fin_de_semana", label: "este fin de semana" });
    expect(match?.entry.id).toBe("availability");
    expect(match?.entry.requiresTool).toBe(false);
    expect(match?.entry.confidenceRules).toContain("never_claim_availability_without_tool");
  });

  it("documents known business-content gaps instead of inventing policy", () => {
    const gaps = listKnowledgeBaseGaps();

    expect(gaps.map((entry) => entry.id)).toContain("puppy_age");
    expect(gaps.find((entry) => entry.id === "puppy_age")?.gap).toContain("edad mínima");
  });
});

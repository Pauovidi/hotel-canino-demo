import { describe, expect, it } from "vitest";

import {
  buildContractAcceptanceRequest,
  buildReservationConfirmationTemplate,
  DEFAULT_CONTRACT_URL,
  isExplicitContractAcceptance,
  isExplicitContractRejection,
} from "./client-requests";
import type { PendingReservationProposal } from "./types";

function proposal(): PendingReservationProposal {
  return {
    proposalId: "proposal_test",
    conversationId: "conv_test",
    phoneNormalized: "34600000000",
    clientStatus: "known",
    clientName: "Laura",
    petName: "Kira",
    checkIn: "2026-12-29",
    checkOut: "2026-12-31",
    checkInSlot: "morning",
    checkOutSlot: "afternoon",
    petCount: 1,
    requestedAt: "2026-06-22T10:00:00.000Z",
    expiresAt: "2026-06-22T12:00:00.000Z",
    status: "proposed",
    source: "whatsapp",
    createdFromMessageId: "msg_test",
  };
}

describe("client request helpers", () => {
  it.each([
    "acepto",
    "si, acepto",
    "sí, acepto",
    "he leído y acepto",
    "confirmo que acepto",
  ])("recognizes explicit contract acceptance: %s", (message) => {
    expect(isExplicitContractAcceptance(message)).toBe(true);
  });

  it.each(["si", "confirmo", "vale", "ok", "perfecto"])(
    "does not treat generic confirmations as contract acceptance: %s",
    (message) => {
      expect(isExplicitContractAcceptance(message)).toBe(false);
    },
  );

  it("recognizes explicit contract rejection", () => {
    expect(isExplicitContractRejection("no acepto las condiciones")).toBe(true);
  });

  it("builds the contract request with the configured link", () => {
    expect(buildContractAcceptanceRequest()).toContain(DEFAULT_CONTRACT_URL);
    expect(buildContractAcceptanceRequest()).toContain("responde: acepto");
  });

  it("renders the post-acceptance reservation confirmation template", () => {
    const rendered = buildReservationConfirmationTemplate({
      ...proposal(),
      price: 90,
      termsAccepted: true,
      termsAcceptedAt: "2026-06-22T10:10:00.000Z",
    });

    expect(rendered).toContain("Reserva confirmada.");
    expect(rendered).toContain("Mascota/s: Kira");
    expect(rendered).toContain("Precio: 90 EUR");
    expect(rendered).toContain("Gracias por confiar en Somos Muy Perros.");
  });
});

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function listSourceFiles(dir: string): string[] {
  const absolute = path.join(root, dir);
  return readdirSync(absolute).flatMap((entry) => {
    const full = path.join(absolute, entry);
    const relative = path.relative(root, full).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) {
      return listSourceFiles(relative);
    }
    return /\.(ts|tsx|mjs)$/.test(entry) ? [relative] : [];
  });
}

describe("conversation authority guardrails", () => {
  it("keeps the authority contract and bypass audit in the repo", () => {
    expect(existsSync(path.join(root, "docs/CONVERSATION_AUTHORITY_CONTRACT.md"))).toBe(true);
    expect(existsSync(path.join(root, "docs/CONVERSATION_BYPASS_AUDIT.md"))).toBe(true);

    const contract = readRepoFile("docs/CONVERSATION_AUTHORITY_CONTRACT.md");
    expect(contract).toContain("Inbound normalizado -> NLU/LLM structured interpretation -> StateReducer");
    expect(contract).toContain("CopyRenderer es el unico que redacta respuesta visible");

    const audit = readRepoFile("docs/CONVERSATION_BYPASS_AUDIT.md");
    expect(audit).toContain("src/app/api/twilio/whatsapp/route.ts");
    expect(audit).toContain("src/lib/hotel/conversations/reservation-flow.ts");
    expect(audit).toContain("keep_temporarily_with_reason");
    expect(audit).toContain("Retirado De Allowlist Legacy");
  });

  it("does not allow direct Twilio client sends from conversation modules", () => {
    const offenders = listSourceFiles("src/lib/hotel/conversations")
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) => /client\.messages\.create|messages\.create/.test(readRepoFile(file)));

    expect(offenders).toEqual([]);
  });

  it("keeps remaining bypasses narrowly documented while migration is progressive", () => {
    const audit = readRepoFile("docs/CONVERSATION_BYPASS_AUDIT.md");
    const allowlisted = [
      "src/app/api/twilio/whatsapp/route.ts | keep_temporarily_with_reason",
      "src/lib/hotel/conversations/service.ts | keep_temporarily_with_reason",
      "src/lib/hotel/conversations/template-preview.ts | keep_temporarily_with_reason",
      "scripts/hotel-scheduled-jobs-lib.mjs | keep_temporarily_with_reason",
    ];

    for (const entry of allowlisted) {
      expect(audit).toContain(entry);
    }
    expect(audit).not.toContain("src/lib/hotel/conversations/reservation-flow.ts | legacy_allowed_temporarily_with_guard");
    expect(audit).not.toContain("src/lib/hotel/conversations/nlu.ts | legacy_allowed_temporarily_with_guard");
  });

  it("blocks visible reservation and NLU reply copy outside CopyRenderer", () => {
    const reservationFlow = readRepoFile("src/lib/hotel/conversations/reservation-flow.ts");
    const nlu = readRepoFile("src/lib/hotel/conversations/nlu.ts");
    const forbiddenReplyPhrases = [
      "Gracias. Ahora dime",
      "Genial. ¿Ya eres cliente",
      "Te ayudo con la reserva",
      "Perdona, no te he entendido bien",
      "De acuerdo, dejamos la reserva",
      "Tenemos disponibilidad",
      "Reiniciado.",
    ];

    for (const phrase of forbiddenReplyPhrases) {
      expect(reservationFlow).not.toContain(phrase);
      expect(nlu).not.toContain(phrase);
    }
    expect(reservationFlow).toContain("renderReservationFlowCopy");
    expect(nlu).toContain("renderKey");
    expect(nlu).not.toMatch(/\breply\s*:/);
  });

  it("routes automatic bot messages through the rendered outbox helper in service", () => {
    const service = readRepoFile("src/lib/hotel/conversations/service.ts");
    const handleInboundSection = service.slice(
      service.indexOf("export async function handleInboundWhatsApp"),
      service.indexOf("export async function sendManualReply"),
    );

    expect(handleInboundSection).not.toMatch(/store\.addMessage\(\s*createMessage\(\{[\s\S]*?senderType:\s*"bot"/);
    expect(service).toContain("copy_rendered");
    expect(service).toContain("outbox_sent");
  });
});

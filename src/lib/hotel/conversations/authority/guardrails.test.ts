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
    expect(audit).toContain("legacy_allowed_temporarily_with_guard");
  });

  it("does not allow direct Twilio client sends from conversation modules", () => {
    const offenders = listSourceFiles("src/lib/hotel/conversations")
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) => /client\.messages\.create|messages\.create/.test(readRepoFile(file)));

    expect(offenders).toEqual([]);
  });

  it("keeps known visible-copy bypasses documented while migration is progressive", () => {
    const audit = readRepoFile("docs/CONVERSATION_BYPASS_AUDIT.md");
    const allowlisted = [
      "src/app/api/twilio/whatsapp/route.ts | legacy_allowed_temporarily_with_guard",
      "src/lib/hotel/conversations/service.ts | legacy_allowed_temporarily_with_guard",
      "src/lib/hotel/conversations/reservation-flow.ts | legacy_allowed_temporarily_with_guard",
      "src/lib/hotel/conversations/nlu.ts | legacy_allowed_temporarily_with_guard",
      "src/lib/hotel/conversations/template-preview.ts | legacy_allowed_temporarily_with_guard",
      "scripts/hotel-scheduled-jobs-lib.mjs | legacy_allowed_temporarily_with_guard",
    ];

    for (const entry of allowlisted) {
      expect(audit).toContain(entry);
    }
  });
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readProjectFile(filePath: string): string {
  return readFileSync(path.join(root, filePath), "utf8");
}

describe("production smoke scripts", () => {
  it("keeps production smoke package scripts on plain node instead of tsx", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const productionSmokes = [
      "smoke:templates",
      "smoke:identity",
      "smoke:conversation",
      "smoke:conversation:latency",
    ];

    for (const scriptName of productionSmokes) {
      expect(packageJson.scripts[scriptName], scriptName).toContain(
        "node scripts/run-production-smoke.mjs",
      );
      expect(packageJson.scripts[scriptName], scriptName).not.toContain("tsx");
    }

    expect(packageJson.scripts["smoke:production"]).toBe(
      "npm run smoke:templates && npm run smoke:identity && npm run smoke:conversation && npm run smoke:conversation:latency",
    );
    expect(packageJson.scripts.postbuild).toBe("npm run smoke:scripts:build");
  });

  it("keeps builder, runner and source smoke scripts available", () => {
    for (const filePath of [
      "scripts/build-production-smokes.mjs",
      "scripts/run-production-smoke.mjs",
      "scripts/conversation-templates-smoke.ts",
      "scripts/conversation-identity-smoke.ts",
      "scripts/conversation-e2e-smoke.ts",
      "scripts/conversation-latency-smoke.ts",
    ]) {
      expect(existsSync(path.join(root, filePath)), filePath).toBe(true);
    }

    const builder = readProjectFile("scripts/build-production-smokes.mjs");
    for (const expected of [
      "conversation-templates-smoke.mjs",
      "conversation-identity-smoke.mjs",
      "conversation-e2e-smoke.mjs",
      "conversation-latency-smoke.mjs",
    ]) {
      expect(builder).toContain(expected);
    }
  });

  it("keeps smoke sources on mock stores and explicit HTTP opt-in", () => {
    const identity = readProjectFile("scripts/conversation-identity-smoke.ts");
    const conversation = readProjectFile("scripts/conversation-e2e-smoke.ts");
    const latency = readProjectFile("scripts/conversation-latency-smoke.ts");

    expect(identity).toContain("class MemoryConversationStore");
    expect(identity).toContain("const directory: ClientDirectory");
    expect(identity).not.toContain("getClientDirectory(");
    expect(identity).not.toContain("GoogleSheetsClient");

    expect(conversation).toContain("class MemoryConversationStore");
    expect(conversation).toContain("CONVERSATION_SMOKE_ALLOW_HTTP");
    expect(conversation).not.toContain("createTwilio");

    expect(latency).toContain("class TimedMemoryConversationStore");
    expect(latency).toContain("openaiCalls");
    expect(latency).not.toContain("OPENAI_API_KEY");
    expect(latency).not.toContain("fetch(");
  });
});

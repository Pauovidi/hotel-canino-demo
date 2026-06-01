import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEntryLogRecord } from "./entry-log";
import {
  cleanManagedEntryLogRecords,
  hideEntryLogRecord,
  loadEntryLogState,
  markEntryLogManaged,
  reopenEntryLogRecord,
  resetEntryLogStateForTests,
} from "./entry-log-state";
import type { ReservationRecord } from "../domain/contracts";

function reservation(overrides: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    reservationId: "res_test_001",
    petKey: "luna",
    status: "confirmada",
    reviewState: "ok",
    source: "demo",
    createdAt: "2026-05-20T10:00:00.000Z",
    updatedAt: "2026-05-20T10:00:00.000Z",
    ownerName: "Cliente Test",
    petName: "Luna",
    phone: "+34 612 345 678",
    checkInDate: "2026-06-01",
    checkInSlot: "morning",
    checkOutDate: "2026-06-03",
    checkOutSlot: "afternoon",
    petCount: 1,
    reviewFlags: [],
    ...overrides,
  };
}

describe("entry log", () => {
  it("builds an operational entry from confirmed chatbot reservations", () => {
    const entry = buildEntryLogRecord(reservation());

    expect(entry).toMatchObject({
      reservationId: "res_test_001",
      displayRef: "...test_001",
      reservationSummary: "Luna · 2026-06-01 → 2026-06-03",
      source: "chatbot",
      action: "confirmada",
      clientName: "Cliente Test",
      clientStatus: "nuevo contacto",
      phoneNormalized: "+34612345678",
      phoneDisplay: "***5678",
      petName: "Luna",
      gestetStatus: "pendiente Gestet",
    });
    expect(JSON.stringify(entry).toLowerCase()).not.toContain("nif");
    expect(JSON.stringify(entry).toLowerCase()).not.toContain("dni");
  });

  it("marks manual review entries without inventing processing state", () => {
    const entry = buildEntryLogRecord(
      reservation({
        status: "pendiente",
        reviewState: "necesita_revision",
        manualFollowupRequired: true,
        source: "manual",
      }),
    );

    expect(entry.source).toBe("manual/revisión");
    expect(entry.action).toBe("revisión manual");
    expect(entry.clientStatus).toBe("bloqueado/revisión");
    expect(entry.gestetStatus).toBe("pendiente Gestet");
  });

  it("tracks managed/hidden state without mutating reservation records", async () => {
    await resetEntryLogStateForTests();

    await markEntryLogManaged("res_test_001", "gestet");
    let state = await loadEntryLogState();
    expect(state.records.res_test_001).toMatchObject({
      status: "managed",
      managedReason: "gestet",
    });

    await hideEntryLogRecord("res_test_001", "removed");
    state = await loadEntryLogState();
    expect(state.records.res_test_001).toMatchObject({
      status: "hidden",
      managedReason: "removed",
    });

    await reopenEntryLogRecord("res_test_001");
    state = await loadEntryLogState();
    expect(state.records.res_test_001).toMatchObject({
      status: "pending",
    });

    await markEntryLogManaged("res_test_001", "gestet");
    const cleaned = await cleanManagedEntryLogRecords();
    state = await loadEntryLogState();
    expect(cleaned.hidden).toBe(1);
    expect(state.records.res_test_001.status).toBe("hidden");

    await resetEntryLogStateForTests();
  });

  it("keeps entry-log operations isolated from the conversation store even if paths are misconfigured", async () => {
    const previousEntryLogPath = process.env.HOTEL_ENTRY_LOG_STATE_PATH;
    const previousConversationsPath = process.env.HOTEL_CONVERSATIONS_STORE_PATH;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "entry-log-conversation-isolation-"));
    const conversationsPath = path.join(tempDir, "hotel-conversations.json");
    const conversationSnapshot = {
      conversations: [
        {
          id: "conv_entry_log_isolation",
          phoneE164: "whatsapp:+34600009991",
          phoneNormalized: "34600009991",
          sourceType: "whatsapp",
          channel: "whatsapp",
          mode: "human",
          status: "open",
          unreadCount: 2,
          lastMessagePreview: "Snippet operativo intacto",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: "2026-06-01T08:05:00.000Z",
          messages: [
            {
              id: "msg_entry_log_isolation",
              conversationId: "conv_entry_log_isolation",
              direction: "inbound",
              body: "Mensaje de prueba",
              createdAt: "2026-06-01T08:00:00.000Z",
              status: "received",
            },
          ],
          events: [
            {
              id: "evt_entry_log_isolation",
              conversationId: "conv_entry_log_isolation",
              eventType: "conversation_created",
              createdAt: "2026-06-01T08:00:00.000Z",
            },
          ],
        },
      ],
      updatedAt: "2026-06-01T08:05:00.000Z",
    };

    try {
      process.env.HOTEL_ENTRY_LOG_STATE_PATH = conversationsPath;
      process.env.HOTEL_CONVERSATIONS_STORE_PATH = conversationsPath;
      await writeFile(conversationsPath, JSON.stringify(conversationSnapshot, null, 2), "utf8");

      await hideEntryLogRecord("res_test_001", "removed");
      await markEntryLogManaged("res_test_002", "gestet");
      await cleanManagedEntryLogRecords();
      await reopenEntryLogRecord("res_test_001");

      const persistedConversationSnapshot = JSON.parse(await readFile(conversationsPath, "utf8"));
      expect(persistedConversationSnapshot).toEqual(conversationSnapshot);
      const state = await loadEntryLogState();
      expect(state.records.res_test_001.status).toBe("pending");
      expect(state.records.res_test_002.status).toBe("hidden");
    } finally {
      if (previousEntryLogPath === undefined) {
        delete process.env.HOTEL_ENTRY_LOG_STATE_PATH;
      } else {
        process.env.HOTEL_ENTRY_LOG_STATE_PATH = previousEntryLogPath;
      }
      if (previousConversationsPath === undefined) {
        delete process.env.HOTEL_CONVERSATIONS_STORE_PATH;
      } else {
        process.env.HOTEL_CONVERSATIONS_STORE_PATH = previousConversationsPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps entry-log API routes and copy scoped to the entry log", () => {
    const routeFiles = [
      "src/app/api/ops/entry-log/[reservationId]/managed/route.ts",
      "src/app/api/ops/entry-log/[reservationId]/remove/route.ts",
      "src/app/api/ops/entry-log/[reservationId]/reopen/route.ts",
      "src/app/api/ops/entry-log/clean-managed/route.ts",
    ];
    const routeSource = routeFiles
      .map((file) => readFileSync(path.join(process.cwd(), file), "utf8"))
      .join("\n");
    const pageSource = readFileSync(
      path.join(process.cwd(), "src/app/admin/registro-entrada/page.tsx"),
      "utf8",
    );

    expect(routeSource).not.toContain("@/lib/hotel/conversations/service");
    expect(routeSource).not.toContain("/api/conversations");
    expect(routeSource).not.toContain("archiveConversation");
    expect(routeSource).not.toContain("unarchiveConversation");
    expect(routeSource).not.toContain("resetConversations");
    expect(pageSource).toContain("Quitar del registro");
    expect(pageSource).toContain("Limpiar gestionados del registro");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationsPanel } from "./panel";
import { buildConversationSeed } from "@/lib/hotel/conversations/demo-seed";
import type {
  ConversationDashboard,
  ConversationRecord,
} from "@/lib/hotel/conversations/types";

function dashboardWith(conversation: ConversationRecord): ConversationDashboard {
  return {
    conversations: [conversation],
    stats: {
      total: 1,
      pending: conversation.humanRequested || conversation.unreadCount > 0 ? 1 : 0,
      human: conversation.mode === "human" ? 1 : 0,
      unread: conversation.unreadCount > 0 ? 1 : 0,
      read: conversation.unreadCount === 0 && !conversation.humanRequested ? 1 : 0,
      archived: conversation.archivedAt ? 1 : 0,
    },
  };
}

describe("conversation panel operational UI", () => {
  it("shows only the human takeover action while the bot owns the conversation", () => {
    const conversation = {
      ...buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0],
      mode: "bot",
    } satisfies ConversationRecord;

    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="sandbox" />,
    );

    expect(html).toContain("Tomar conversación");
    expect(html).not.toContain("Devolver al bot");
  });

  it("shows only the bot return action while a human owns the conversation", () => {
    const conversation = {
      ...buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0],
      mode: "human",
    } satisfies ConversationRecord;

    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="sandbox" />,
    );

    expect(html).toContain("Devolver al bot");
    expect(html).not.toContain("Tomar conversación");
  });

  it("keeps technical provider status out of the main timeline banners", () => {
    const conversation = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0];
    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="sandbox" />,
    );

    expect(html).toContain("Estado técnico");
    expect(html).toContain("Proveedor: Twilio WhatsApp");
    expect(html).not.toContain("Twilio Sandbox activo para pruebas de WhatsApp.");
    expect(html).not.toContain("conversation-notice");
    expect(html.toLowerCase()).not.toContain("nif");
    expect(html.toLowerCase()).not.toContain("dni");
  });

  it("renders a compact composer and short human metric label", () => {
    const conversation = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0];
    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="mock" />,
    );

    expect(html).toContain(">Humano<");
    expect(html).not.toContain("En humano");
    expect(html).toContain("conversation-composer-field");
    expect(html).toContain("conversation-composer-actions");
    expect(html).toContain("conversation-send-button");
    expect(html).toContain("conversation-video-mock-button");
    expect(html).toContain("Respuesta manual del equipo");
    expect(html).toContain("Enviar");
    expect(html).toContain("Adjuntar vídeo");
  });

  it("keeps inbox filters compact in narrow layouts", () => {
    const conversation = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0];
    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="sandbox" />,
    );
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

    for (const label of ["Todas", "Pendientes", "Humano", "Bot", "Leídas"]) {
      expect(html).toContain(label);
    }

    expect(css).toContain("grid-template-rows: auto auto auto auto minmax(0, 1fr)");
    expect(css).toContain(".conversation-tabs");
    expect(css).toContain("flex-wrap: nowrap");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("white-space: nowrap");
    expect(html).not.toContain("En humano");
  });

  it("keeps the polling implementation controlled and non-overlapping", () => {
    const conversation = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0];
    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="sandbox" />,
    );
    const source = readFileSync(join(process.cwd(), "src/app/admin/conversations/panel.tsx"), "utf8");

    expect(html).toContain("Actualizado");
    expect(source).toContain("CONVERSATION_PANEL_POLL_INTERVAL_MS = 3000");
    expect(source).toContain("refreshPromiseRef");
    expect(source).toContain("AbortController");
    expect(source).toContain("visibilitychange");
    expect(source).toContain("setReply(\"\")");
    expect(source).toContain("requestAnimationFrame");
  });

  it("renders archive controls and preserves chronological timeline markup", () => {
    const conversation = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations[0];
    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboardWith(conversation)} twilioProviderMode="sandbox" />,
    );
    const source = readFileSync(join(process.cwd(), "src/app/admin/conversations/panel.tsx"), "utf8");

    expect(html).toContain("Archivadas");
    expect(html).toContain("Archivar");
    expect(source).toContain("conversation_archived");
    expect(source).toContain("conversation_reset_requested");
    expect(source).toContain("isOperationalCommandBody");
    expect(source).toContain("setMode(\"all\")");
    expect(source).toContain("timeline.scrollHeight <= timeline.clientHeight");
    expect(source).toContain("left.createdAt.localeCompare(right.createdAt)");
  });
});

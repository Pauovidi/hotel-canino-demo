import { ConversationsPanel } from "./panel";
import { SiteShell } from "@/components/site-shell";
import { verifyPanelPageAccess } from "@/lib/hotel/conversations/auth";
import { listConversationDashboard } from "@/lib/hotel/conversations/service";
import { readTwilioWhatsAppConfig } from "@/lib/hotel/twilio/client";
import type { ConversationDashboard } from "@/lib/hotel/conversations/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function emptyConversationDashboard(): ConversationDashboard {
  return {
    conversations: [],
    stats: {
      total: 0,
      unread: 0,
      pending: 0,
      human: 0,
      read: 0,
      archived: 0,
    },
  };
}

function safeDashboardError(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code).slice(0, 80)
        : undefined,
  };
}

export default async function ConversationsAdminPage() {
  const auth = await verifyPanelPageAccess();

  if (!auth.ok) {
    return (
      <SiteShell headerVariant="panel">
        <section className="page-intro">
          <p className="demo-kicker">Panel protegido</p>
          <h1 className="page-title">Panel de conversaciones</h1>
          <p className="page-description">
            Configura HOTEL_PANEL_USERNAME y HOTEL_PANEL_PASSWORD para acceder al
            panel de conversaciones en producción.
          </p>
        </section>
      </SiteShell>
    );
  }

  const dashboard = await listConversationDashboard().catch((error) => {
    console.error("admin_conversations_dashboard_load_failed", safeDashboardError(error));
    return emptyConversationDashboard();
  });
  const twilioConfig = readTwilioWhatsAppConfig();

  return (
    <SiteShell compact headerVariant="panel">
      <section className="page-intro conversation-page-intro">
        <p className="demo-kicker">Operaciones</p>
        <h1 className="page-title">Panel de conversaciones</h1>
        <p className="page-description">
          Centraliza WhatsApp, handoffs del bot y contexto de reservas en un único inbox operativo.
        </p>
      </section>
      <ConversationsPanel
        initialDashboard={dashboard}
        twilioProviderMode={twilioConfig.providerMode}
      />
    </SiteShell>
  );
}

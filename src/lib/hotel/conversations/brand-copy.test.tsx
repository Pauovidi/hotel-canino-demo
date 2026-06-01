import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoNavItems } from "@/components/demo-data";
import { ConversationsPanel } from "@/app/admin/conversations/panel";
import { PublicChatWidget } from "@/components/public-chat-widget";
import { PublicSiteHeader } from "@/components/public-site-header";
import { SiteShell } from "@/components/site-shell";
import { buildConversationSeed } from "./demo-seed";
import type { ConversationDashboard } from "./types";

function readSurface(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function forbiddenReferenceCopyPatterns() {
  const brand = String.fromCharCode(77, 117, 100, 97, 110, 122, 97, 115);
  const shortBrand = String.fromCharCode(77, 70, 77);

  return [
    new RegExp(`\\b${brand}FM\\b`, "i"),
    new RegExp(`\\bSoporte${brand}FM\\b`, "i"),
    new RegExp(`\\b${shortBrand}\\b`),
    new RegExp(`\\b${brand.toLowerCase()}s?\\b`, "i"),
    /\benv[ií]o\b/i,
  ];
}

describe("conversations panel visible demo copy", () => {
  it("exposes the conversations panel from demo navigation data", () => {
    expect(demoNavItems).toContainEqual({
      href: "/admin/conversations",
      label: "Panel conversaciones",
    });
    expect(readSurface("src/components/public-site-header.tsx")).toContain(
      "Panel conversaciones",
    );
    expect(readSurface("src/app/admin/page.tsx")).toContain(
      "Abrir panel de conversaciones",
    );
  });

  it("renders the shared Somos Muy Perros header with final navigation", () => {
    const headerHtml = renderToStaticMarkup(<PublicSiteHeader />);
    const shellHtml = renderToStaticMarkup(
      <SiteShell>
        <section>
          <h1>Panel de conversaciones</h1>
        </section>
      </SiteShell>,
    );

    expect(headerHtml).toContain("Somos Muy Perros");
    expect(headerHtml).toContain("somos-muy-perros-logo.png");
    expect(headerHtml).toContain("Inicio");
    expect(headerHtml).toContain("Recepción emails");
    expect(headerHtml).toContain("Panel conversaciones");
    expect(headerHtml).toContain("Formulario web");
    expect(headerHtml).not.toContain("Formulario oficial");
    expect(headerHtml).not.toMatch(/>Chat</);
    expect(headerHtml).not.toContain("Hotel canino");
    expect(headerHtml).not.toMatch(/<strong>Somos Muy Perros<\/strong>/);
    expect(shellHtml).toContain("Somos Muy Perros");
    expect(shellHtml).toContain("Panel conversaciones");
    expect(shellHtml).toContain("Formulario web");
    expect(shellHtml).not.toContain("Demo hotel canino");
    expect(shellHtml).not.toContain("Formulario real");
    expect(shellHtml).not.toMatch(/>SM</);
  });

  it("renders a non-empty Somos Muy Perros inbox with mock WhatsApp notice", () => {
    const conversations = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations;
    const dashboard: ConversationDashboard = {
      conversations,
      stats: {
        total: conversations.length,
        pending: conversations.filter(
          (conversation) => conversation.humanRequested || conversation.unreadCount > 0,
        ).length,
        human: conversations.filter((conversation) => conversation.mode === "human").length,
        unread: conversations.filter((conversation) => conversation.unreadCount > 0).length,
        read: conversations.filter(
          (conversation) => conversation.unreadCount === 0 && !conversation.humanRequested,
        ).length,
        archived: 0,
      },
    };

    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboard} twilioProviderMode="mock" />,
    );

    expect(html).toContain("Inbox WhatsApp");
    expect(html).toContain("Proveedor: Twilio WhatsApp");
    expect(html).toContain("Estado técnico");
    expect(html).toContain("Mock");
    expect(html).toContain("Registro de entrada");
    expect(html).toContain("Pendientes");
    expect(html).toContain("Humano");
    expect(html).not.toContain("En humano");
    expect(html).toContain("Todas");
    expect(html).toContain("Marta R.");
    expect(html).toContain("Mascota: Luna");
    expect(html).toContain("Respuesta manual del equipo");
    expect(html).toContain("Adjuntar vídeo");
    expect(html).toContain("Modo demo: se guarda en el timeline, no sale por WhatsApp real.");
    expect(html).toContain("Actualizar");
    expect(html).not.toContain("conversation-notice");
    expect(html).not.toContain("No hay conversaciones para este filtro");
    expect(html).not.toContain("Panel reservas");
    expect(html).not.toContain("Panel de reservas");
    expect(html).not.toContain("Ver panel operativo");
    expect(html).not.toContain("Demo clínica");
    expect(html).not.toContain("Demo hotel canino");
    expect(html).not.toMatch(/>Ops</);
    expect(html).not.toMatch(/>SM</);
  });

  it("renders sandbox and real Twilio provider states without changing provider", () => {
    const conversations = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations;
    const dashboard: ConversationDashboard = {
      conversations,
      stats: {
        total: conversations.length,
        pending: 0,
        human: 0,
        unread: 0,
        read: conversations.length,
        archived: 0,
      },
    };
    const sandbox = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboard} twilioProviderMode="sandbox" />,
    );
    const real = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboard} twilioProviderMode="real" />,
    );

    expect(sandbox).toContain("Proveedor: Twilio WhatsApp");
    expect(sandbox).toContain("Sandbox");
    expect(sandbox).toContain("Sandbox: el destinatario debe haberse unido antes de responder.");
    expect(real).toContain("Proveedor: Twilio WhatsApp");
    expect(real).toContain("Real");
    expect(real).toContain("Twilio real activo: revisa el mensaje antes de enviarlo.");
  });

  it("renders client directory badges without exposing NIF", () => {
    const conversations = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations;
    conversations[0] = {
      ...conversations[0],
      clientStatus: "known",
      clientConfidence: "strong",
      clientMatchType: "phone",
      clientName: "Cliente Habitual",
      clientEmail: "cliente@example.com",
      clientSource: "google_sheets_client_directory",
      clientSheetName: "CLIENTES",
      clientSheetRow: 2,
      clientWarnings: [],
    };
    conversations[1] = {
      ...conversations[1],
      clientStatus: "blocked",
      clientWarnings: ["NO COGER RESERVA"],
      requiresManualReview: true,
    };
    const dashboard: ConversationDashboard = {
      conversations,
      stats: {
        total: conversations.length,
        pending: 1,
        human: 1,
        unread: 1,
        read: conversations.length - 1,
        archived: 0,
      },
    };

    const html = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboard} twilioProviderMode="mock" />,
    );

    expect(html).toContain("Cliente habitual");
    expect(html).toContain("Nuevo contacto");
    expect(html).toContain("Directorio");
    expect(html).toContain("CLIENTES · fila 2");
    expect(html).toContain("cliente@example.com");
    expect(html).not.toContain("NIF");
    expect(html.toLowerCase()).not.toContain("dni");
  });

  it("keeps the conversations page copy presentable", () => {
    const surfaces = [
      "src/app/admin/conversations/page.tsx",
      "src/app/admin/conversations/panel.tsx",
      "src/components/demo-data.ts",
      "src/components/public-site-header.tsx",
      "src/components/site-shell.tsx",
    ]
      .map(readSurface)
      .join("\n");

    expect(surfaces).toContain("Panel de conversaciones");
    expect(surfaces).toContain("Centraliza WhatsApp, handoffs del bot y contexto de reservas en un único inbox operativo.");
    expect(surfaces).toContain("Proveedor: Twilio WhatsApp");
    expect(surfaces).toContain("Registro de entrada");
    expect(surfaces).toContain("Adjuntar vídeo");
    expect(surfaces).toContain("media-mock");
    expect(surfaces).toContain("Formulario web");
    expect(surfaces).not.toContain("Panel reservas");
    expect(surfaces).not.toContain("Panel de reservas");
    expect(surfaces).not.toContain("Formulario oficial");
    expect(surfaces).not.toContain("Demo clínica");
    expect(surfaces).not.toContain("Demo hotel canino");
    expect(surfaces).not.toContain("Formulario real");
    expect(surfaces).not.toMatch(/label:\s*"Ops"/);
    expect(surfaces).not.toMatch(/>SM</);
  });

  it("renders dark action buttons with visible text in SSR surfaces", () => {
    const conversations = buildConversationSeed("2026-05-06T08:00:00.000Z").conversations;
    const dashboard: ConversationDashboard = {
      conversations,
      stats: {
        total: conversations.length,
        pending: 0,
        human: 0,
        unread: 0,
        read: conversations.length,
        archived: 0,
      },
    };
    const panelHtml = renderToStaticMarkup(
      <ConversationsPanel initialDashboard={dashboard} twilioProviderMode="mock" />,
    );
    const chatHtml = renderToStaticMarkup(<PublicChatWidget />);

    expect(panelHtml).toContain("Actualizar");
    expect(chatHtml).toContain("Enviar");
  });

  it("keeps entry log route protected and free of document identifiers", () => {
    const page = readSurface("src/app/admin/registro-entrada/page.tsx");
    const entryLog = readSurface("src/lib/hotel/application/entry-log.ts");

    expect(page).toContain("verifyPanelPageAccess");
    expect(page).toContain("Registro de entrada");
    expect(page).toContain("No hay entradas en esta vista.");
    expect(page).toContain("Pendientes");
    expect(page).toContain("Gestionados");
    expect(page).toContain("Limpiar gestionados");
    expect(page).toContain("Origen");
    expect(page).toContain("Acción");
    expect(page).toContain("Cliente");
    expect(page).toContain("Contacto");
    expect(page).toContain("Estado cliente");
    expect(page).not.toContain("Identificador");
    expect(page).toContain("Mascota");
    expect(page).toContain("Entrada");
    expect(page).toContain("Salida");
    expect(page).toContain("Reserva");
    expect(page).toContain("Acciones");
    expect(page).toContain("Gestet");
    expect(entryLog).toContain("pendiente Gestet");
    expect(page.toLowerCase()).not.toContain("nif");
    expect(page.toLowerCase()).not.toContain("dni");
    expect(entryLog.toLowerCase()).not.toContain("nif");
    expect(entryLog.toLowerCase()).not.toContain("dni");
  });

  it("documents the media attachment mock without enabling real uploads", () => {
    const doc = readSurface("docs/CONVERSATION_MEDIA_ATTACHMENTS_V0.md");
    const panel = readSurface("src/app/admin/conversations/panel.tsx");

    expect(doc).toContain("Estado actual");
    expect(doc).toContain("No guardar videos en DB");
    expect(doc).toContain("Cloudflare R2");
    expect(doc).toContain("MinIO");
    expect(panel).toContain("Adjuntar vídeo");
    expect(panel).toContain("Mock");
    expect(panel).not.toContain('type="file"');
    expect(panel).not.toContain("MediaUrl");
  });


  it("does not expose reference moving-company copy in user-facing panel surfaces", () => {
    const surfaces = [
      "src/app/admin/conversations/page.tsx",
      "src/app/admin/conversations/panel.tsx",
      "src/components/demo-data.ts",
      "src/components/public-site-header.tsx",
      "src/components/site-shell.tsx",
      "src/lib/hotel/conversations/demo-seed.ts",
      "docs/CONVERSATIONS_PANEL_V0.md",
      "docs/TWILIO_WHATSAPP_REAL_V0.md",
    ]
      .map(readSurface)
      .join("\n");

    expect(surfaces).not.toContain("Formulario oficial");
    expect(surfaces).toContain("Formulario web");

    for (const pattern of forbiddenReferenceCopyPatterns()) {
      expect(surfaces).not.toMatch(pattern);
    }
  });
});

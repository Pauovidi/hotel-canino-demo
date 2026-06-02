import { NextResponse } from "next/server";
import { requirePanelAuth } from "@/lib/hotel/conversations/auth";
import {
  listConversationDashboard,
  handleInboundWhatsApp,
  redactConversationSensitiveText,
} from "@/lib/hotel/conversations/service";
import type { ConversationListFilters } from "@/lib/hotel/conversations/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDashboardError(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code).slice(0, 80)
        : undefined,
  };
}

function sanitizeDemoInboundPayload(body: {
  from?: string;
  body?: string;
  messageSid?: string;
  displayName?: string;
}) {
  return {
    from: body.from?.slice(0, 240),
    body: body.body ? redactConversationSensitiveText(body.body).slice(0, 1000) : undefined,
    messageSid: body.messageSid?.slice(0, 240),
    displayName: body.displayName?.slice(0, 240),
    source: "admin_conversations_demo",
  };
}

export async function GET(request: Request) {
  const auth = requirePanelAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const filters: ConversationListFilters = {
    query:
      url.searchParams.get("query") ??
      url.searchParams.get("search") ??
      undefined,
    status: url.searchParams.get("status") ?? undefined,
    unreadOnly: ["1", "true", "yes"].includes(
      (url.searchParams.get("unread") ?? url.searchParams.get("unreadOnly") ?? "").toLowerCase(),
    ),
    mode: (url.searchParams.get("mode") as ConversationListFilters["mode"]) ?? "all",
  };
  let dashboard: Awaited<ReturnType<typeof listConversationDashboard>>;
  try {
    dashboard = await listConversationDashboard(filters);
  } catch (error) {
    console.error("api_conversations_dashboard_load_failed", safeDashboardError(error));
    return NextResponse.json(
      { ok: false, error: "No se pudo cargar el panel de conversaciones." },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, ...dashboard });
}

export async function POST(request: Request) {
  const auth = requirePanelAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json()) as {
    from?: string;
    body?: string;
    messageSid?: string;
    displayName?: string;
  };

  if (!body.from || !body.body) {
    return NextResponse.json(
      { ok: false, error: "from and body are required" },
      { status: 400 },
    );
  }

  const result = await handleInboundWhatsApp({
    from: body.from,
    body: body.body,
    messageSid: body.messageSid,
    displayName: body.displayName,
    rawPayload: sanitizeDemoInboundPayload(body),
  });

  return NextResponse.json({ ok: true, ...result });
}

import { NextResponse } from "next/server";
import { requirePanelAuth } from "@/lib/hotel/conversations/auth";
import { listConversationDashboard } from "@/lib/hotel/conversations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

function parseLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  const auth = requirePanelAuth(request);

  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId") ?? undefined;
  const since = url.searchParams.get("since") ?? undefined;
  const limit = parseLimit(url.searchParams.get("limit")) ?? 100;
  const dashboard = await listConversationDashboard();
  const events = dashboard.conversations
    .flatMap((conversation) => conversation.events)
    .filter((event) => !conversationId || event.conversationId === conversationId)
    .filter((event) => !since || event.createdAt > since)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);

  return NextResponse.json({ ok: true, events }, { headers: NO_STORE_HEADERS });
}

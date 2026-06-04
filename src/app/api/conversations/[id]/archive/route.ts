import { NextResponse } from "next/server";
import { requirePanelAuth } from "@/lib/hotel/conversations/auth";
import {
  archiveConversation,
  unarchiveConversation,
} from "@/lib/hotel/conversations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

function safeArchiveError(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    safeErrorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code).slice(0, 80)
        : undefined,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requirePanelAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { reason?: string };

  try {
    const conversation = await archiveConversation(id, auth.agent, body.reason);
    return NextResponse.json({ ok: true, conversation }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof Error && error.message === "Conversation not found") {
      return NextResponse.json(
        { ok: false, error: "Conversation not found" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    console.error("conversations_store_archive_failed", safeArchiveError(error));
    return NextResponse.json(
      { ok: false, error: "No se pudo archivar la conversación." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requirePanelAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { id } = await context.params;

  try {
    const conversation = await unarchiveConversation(id, auth.agent);
    return NextResponse.json({ ok: true, conversation }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof Error && error.message === "Conversation not found") {
      return NextResponse.json(
        { ok: false, error: "Conversation not found" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    console.error("conversations_store_restore_failed", safeArchiveError(error));
    return NextResponse.json(
      { ok: false, error: "No se pudo restaurar la conversación." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

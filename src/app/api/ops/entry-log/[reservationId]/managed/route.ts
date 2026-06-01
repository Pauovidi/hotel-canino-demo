import { NextResponse } from "next/server";
import { markEntryLogManaged } from "@/lib/hotel/application/entry-log-state";
import { requirePanelAuth } from "@/lib/hotel/conversations/auth";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ reservationId: string }> },
) {
  const auth = requirePanelAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { reservationId } = await context.params;
  await markEntryLogManaged(decodeURIComponent(reservationId), "gestet");
  return NextResponse.redirect(new URL("/admin/registro-entrada", request.url), 303);
}

import { NextResponse } from "next/server";
import { cleanManagedEntryLogRecords } from "@/lib/hotel/application/entry-log-state";
import { requirePanelAuth } from "@/lib/hotel/conversations/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = requirePanelAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  await cleanManagedEntryLogRecords();
  return NextResponse.redirect(new URL("/admin/registro-entrada?estado=gestionados", request.url), 303);
}

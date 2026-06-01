import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { formatSpanishDate } from "@/components/demo-data";
import { listEntryLogRecords } from "@/lib/hotel/application/entry-log";
import { verifyPanelPageAccess } from "@/lib/hotel/conversations/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EntryLogSearchParams = {
  estado?: string;
};

function normalizeEntryLogView(value?: string): "pending" | "managed" | "all" {
  if (value === "gestionados") {
    return "managed";
  }

  if (value === "todos") {
    return "all";
  }

  return "pending";
}

function viewHref(view: "pending" | "managed" | "all") {
  if (view === "managed") {
    return "/admin/registro-entrada?estado=gestionados";
  }

  if (view === "all") {
    return "/admin/registro-entrada?estado=todos";
  }

  return "/admin/registro-entrada";
}

export default async function EntryLogPage({
  searchParams,
}: {
  searchParams?: Promise<EntryLogSearchParams>;
}) {
  const auth = await verifyPanelPageAccess();

  if (!auth.ok) {
    return (
      <SiteShell>
        <section className="page-intro">
          <p className="demo-kicker">Panel protegido</p>
          <h1 className="page-title">Registro de entrada</h1>
          <p className="page-description">
            Configura HOTEL_PANEL_USERNAME y HOTEL_PANEL_PASSWORD para acceder al
            registro operativo en producción.
          </p>
        </section>
      </SiteShell>
    );
  }

  const params = await searchParams;
  const view = normalizeEntryLogView(params?.estado);
  const records = await listEntryLogRecords({ status: view });

  return (
    <SiteShell compact>
      <section className="page-intro">
        <p className="demo-kicker">Operativa</p>
        <h1 className="page-title">Registro de entrada</h1>
        <p className="page-description">
          Lista de reservas y solicitudes que el equipo debe revisar antes de
          pasarlas a Gestet o marcarlas como gestionadas.
        </p>
      </section>

      <section className="demo-panel entry-log-panel">
        <div className="entry-log-toolbar">
          <div className="entry-log-tabs" aria-label="Estado del registro">
            <Link className={view === "pending" ? "is-active" : ""} href={viewHref("pending")}>
              Pendientes
            </Link>
            <Link className={view === "managed" ? "is-active" : ""} href={viewHref("managed")}>
              Gestionados
            </Link>
            <Link className={view === "all" ? "is-active" : ""} href={viewHref("all")}>
              Todos
            </Link>
          </div>
          <form action="/api/ops/entry-log/clean-managed" method="post">
            <button className="entry-log-secondary-action" type="submit">
              Limpiar gestionados
            </button>
          </form>
        </div>
        {records.length === 0 ? (
          <div className="conversation-empty">
            <strong>No hay entradas en esta vista.</strong>
            <span>
              Cuando entren reservas o revisiones pendientes, aparecerán aquí.
            </span>
          </div>
        ) : (
          <div className="entry-log-table" aria-label="Registro de entrada">
            <div className="entry-log-row entry-log-head">
              <span>Entrada</span>
              <span>Salida</span>
              <span>Cliente</span>
              <span>Contacto</span>
              <span>Mascota</span>
              <span>Origen</span>
              <span>Acción</span>
              <span>Estado cliente</span>
              <span>Reserva</span>
              <span>Notas</span>
              <span>Gestet</span>
              <span>Acciones</span>
            </div>
            {records.map((record) => (
              <article key={record.reservationId} className="entry-log-row">
                <span>{formatSpanishDate(record.checkInDate)}</span>
                <span>{formatSpanishDate(record.checkOutDate)}</span>
                <strong>{record.clientName}</strong>
                <span>{record.phoneDisplay}</span>
                <strong>{record.petName}</strong>
                <span>{record.source}</span>
                <span className="demo-state demo-state-manual">{record.action}</span>
                <span>{record.clientStatus}</span>
                <span title={record.reservationId}>
                  {record.reservationSummary}
                  <small>Ref. {record.displayRef}</small>
                </span>
                <span title={record.notes}>{record.notes}</span>
                <span>{record.gestetStatus}</span>
                <span className="entry-log-actions">
                  {record.operationalStatus === "pending" ? (
                    <>
                      <form
                        action={`/api/ops/entry-log/${encodeURIComponent(record.reservationId)}/managed`}
                        method="post"
                      >
                        <button type="submit">Gestionado</button>
                      </form>
                      <form
                        action={`/api/ops/entry-log/${encodeURIComponent(record.reservationId)}/remove`}
                        method="post"
                      >
                        <button type="submit">Quitar</button>
                      </form>
                    </>
                  ) : (
                    <form
                      action={`/api/ops/entry-log/${encodeURIComponent(record.reservationId)}/reopen`}
                      method="post"
                    >
                      <button type="submit">Reabrir</button>
                    </form>
                  )}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </SiteShell>
  );
}

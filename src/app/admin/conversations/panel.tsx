"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCheck,
  Circle,
  Archive,
  ExternalLink,
  Film,
  MessageSquareText,
  RefreshCcw,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import type {
  ConversationDashboard,
  ConversationListFilters,
  ConversationMode,
  ConversationRecord,
} from "@/lib/hotel/conversations/types";

interface ConversationsPanelProps {
  initialDashboard: ConversationDashboard;
  twilioProviderMode: "mock" | "sandbox" | "real";
}

type FilterMode = NonNullable<ConversationListFilters["mode"]>;
export const CONVERSATION_PANEL_POLL_INTERVAL_MS = 3000;

type ActionResponsePayload = { ok?: boolean; error?: string; conversation?: ConversationRecord };

const filters: Array<{ label: string; value: FilterMode }> = [
  { label: "Todas", value: "all" },
  { label: "Pendientes", value: "pending" },
  { label: "Humano", value: "human" },
  { label: "Bot", value: "bot" },
  { label: "Leídas", value: "read" },
];

function formatDate(value?: string) {
  if (!value) {
    return "Sin actividad";
  }

  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export async function readJsonOrEmpty(response: Response): Promise<ActionResponsePayload> {
  const text = await response.text();
  if (!text.trim()) {
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    return response.ok
      ? { ok: true }
      : { ok: false, error: text.slice(0, 180) || `HTTP ${response.status}` };
  }

  try {
    return JSON.parse(text) as ActionResponsePayload;
  } catch {
    return response.ok
      ? { ok: true }
      : { ok: false, error: "La respuesta del servidor no se pudo leer." };
  }
}

function formatEventType(value: string) {
  const labels: Record<string, string> = {
    auto_reply_skipped_human_mode: "Bot pausado por modo humano",
    bot_reply_sent: "Respuesta automática enviada",
    conversation_created: "Conversación creada",
    conversation_archived: "Conversación archivada",
    conversation_unarchived: "Conversación restaurada",
    conversation_reopened_from_inbound: "Reabierta por WhatsApp entrante",
    human_requested: "Handoff solicitado",
    client_directory_ambiguous: "Match ambiguo de cliente",
    client_directory_blocked: "Cliente bloqueado en directorio",
    client_directory_match: "Cliente habitual detectado",
    client_directory_created_from_reservation: "CLIENTES creado tras reserva",
    client_directory_created_pending_name: "CLIENTES creado con nombre pendiente",
    client_directory_existing_from_reservation: "CLIENTES existente actualizado",
    client_directory_upsert_failed: "Alta CLIENTES pendiente",
    client_directory_upsert_skipped_ambiguous: "Alta CLIENTES pendiente por ambigüedad",
    client_directory_upsert_skipped_blocked: "Alta CLIENTES bloqueada",
    client_directory_upsert_skipped_invalid_phone: "Alta CLIENTES pendiente por teléfono",
    manual_reply_failed: "Respuesta manual fallida",
    manual_reply_sent: "Respuesta manual enviada",
    marked_read: "Marcada como leída",
    media_attachment_mock_requested: "Vídeo mock solicitado",
    mode_changed: "Modo actualizado",
    nlu_classified: "Intent detectado",
    reservation_context_detected: "Reserva detectada",
  };

  return labels[value] ?? value.replaceAll("_", " ");
}

function formatSender(value: string) {
  const labels: Record<string, string> = {
    bot: "Bot",
    human: "Equipo",
    system: "Sistema",
    user: "Cliente",
  };

  return labels[value] ?? value;
}

function conversationTitle(conversation: ConversationRecord) {
  return conversation.clientName ?? conversation.customerName ?? conversation.displayName ?? conversation.phoneE164;
}

function isStrongDirectoryMatch(conversation: ConversationRecord) {
  return (
    conversation.clientStatus === "known" &&
    conversation.clientConfidence === "strong" &&
    (conversation.clientMatchType === "phone" || conversation.clientMatchType === "email")
  );
}

function visibleNameSource(conversation: ConversationRecord) {
  if (conversation.clientName && isStrongDirectoryMatch(conversation)) {
    return "CLIENTES";
  }

  if (conversation.displayName) {
    return "WhatsApp";
  }

  if (conversation.customerName) {
    return "Conversación";
  }

  return "Teléfono";
}

function matchTypeLabel(conversation: ConversationRecord) {
  if (isStrongDirectoryMatch(conversation)) {
    return conversation.clientMatchType === "email" ? "email" : "teléfono";
  }

  if (conversation.clientMatchType === "name") {
    return "nombre";
  }

  return "ninguno";
}

function clientDirectoryUpsertLabel(conversation: ConversationRecord) {
  const labels: Record<string, string> = {
    created: "CLIENTES creado",
    created_pending_name: "CLIENTES creado · nombre pendiente",
    existing: "CLIENTES existente",
    failed: "alta CLIENTES pendiente",
    skipped_ambiguous: "alta CLIENTES pendiente · revisión",
    skipped_blocked: "alta CLIENTES bloqueada",
    skipped_invalid_phone: "alta CLIENTES pendiente · teléfono",
  };

  return conversation.clientDirectoryUpsertKind
    ? labels[conversation.clientDirectoryUpsertKind] ?? conversation.clientDirectoryUpsertKind
    : undefined;
}

function reservationStatusLabel(conversation: ConversationRecord) {
  const status = conversation.reservationFlow?.status;
  const labels: Record<string, string> = {
    asking_client_kind: "recopilando datos",
    asking_existing_email: "recopilando datos",
    collecting_owner: "recopilando datos",
    collecting_pet: "recopilando datos",
    collecting_dates: "recopilando datos",
    collecting_notes: "recopilando datos",
    collecting_visit: "recopilando datos",
    pending_availability: "pendiente disponibilidad",
    pending_confirmation: "pendiente confirmación",
    confirmed: "confirmada",
    rejected: "rechazada",
    no_availability: "sin disponibilidad",
  };

  return status ? labels[status] ?? status : "sin reserva activa";
}

function availabilityLabel(conversation: ConversationRecord) {
  const status = conversation.reservationFlow?.availabilityStatus;
  if (status === "available") return "disponible";
  if (status === "unavailable") return "no disponible";
  return "pendiente";
}

function visitLabel(value?: boolean | null) {
  if (value === true) return "sí";
  if (value === false) return "no";
  return "sin responder";
}

function conversationSubtitle(conversation: ConversationRecord) {
  const parts = [
    conversation.phoneE164,
    conversation.clientEmail,
    conversation.petName ? `Mascota: ${conversation.petName}` : undefined,
  ].filter(Boolean);

  return parts.join(" · ");
}

function isOperationalCommandBody(value: string) {
  return /^(reiniciar|reset|empezar de nuevo|volver a empezar|borrar conversacion|empezar otra vez|olvida lo anterior)$/i.test(
    value.trim(),
  );
}

function shouldShowTimelineEvent(eventType: string) {
  return ![
    "nlu_classified",
    "conversation_reset_requested",
    "reservation_context_detected",
    "reservation_proposal_checked",
    "reservation_confirmation_checked",
    "bot_reply_sent",
    "client_directory_match",
  ].includes(eventType);
}

function conversationPreview(conversation: ConversationRecord) {
  if (
    conversation.lastMessagePreview &&
    !isOperationalCommandBody(conversation.lastMessagePreview)
  ) {
    return conversation.lastMessagePreview;
  }

  const visibleMessage = [...conversation.messages]
    .reverse()
    .find((message) => !isOperationalCommandBody(message.body));

  return visibleMessage?.body ?? "Sin mensajes visibles todavía.";
}

function conversationMatchesQuery(conversation: ConversationRecord, value: string) {
  const query = value.trim().toLowerCase();
  if (!query) {
    return true;
  }

  const haystack = [
    conversation.phoneE164,
    conversation.phoneNormalized,
    conversation.displayName,
    conversation.customerName,
    conversation.clientName,
    conversation.clientStatus,
    conversation.clientSource,
    ...(conversation.clientWarnings ?? []),
    conversation.petName,
    conversation.channel,
    conversation.status,
    ...(conversation.tags ?? []),
    conversation.lastMessagePreview,
    ...conversation.messages.map((message) => message.body),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function conversationMatchesMode(conversation: ConversationRecord, mode: FilterMode) {
  if (mode === "archived") {
    return Boolean(conversation.archivedAt);
  }

  if (conversation.archivedAt) {
    return false;
  }

  if (mode === "bot" || mode === "human") {
    return conversation.mode === mode;
  }

  if (mode === "pending") {
    return conversation.humanRequested || conversation.unreadCount > 0;
  }

  if (mode === "read") {
    return conversation.unreadCount === 0 && !conversation.humanRequested;
  }

  return true;
}

function activeStatsContribution(conversation: ConversationRecord) {
  if (conversation.archivedAt) {
    return {
      total: 0,
      unread: 0,
      pending: 0,
      human: 0,
      read: 0,
    };
  }

  return {
    total: 1,
    unread: conversation.unreadCount > 0 ? 1 : 0,
    pending: conversation.humanRequested || conversation.unreadCount > 0 ? 1 : 0,
    human: conversation.mode === "human" ? 1 : 0,
    read: conversation.unreadCount === 0 && !conversation.humanRequested ? 1 : 0,
  };
}

function reconcileStats(
  stats: ConversationDashboard["stats"],
  previous: ConversationRecord,
  next: ConversationRecord,
): ConversationDashboard["stats"] {
  const before = activeStatsContribution(previous);
  const after = activeStatsContribution(next);
  const archivedDelta = (next.archivedAt ? 1 : 0) - (previous.archivedAt ? 1 : 0);

  return {
    total: Math.max(0, stats.total - before.total + after.total),
    unread: Math.max(0, stats.unread - before.unread + after.unread),
    pending: Math.max(0, stats.pending - before.pending + after.pending),
    human: Math.max(0, stats.human - before.human + after.human),
    read: Math.max(0, stats.read - before.read + after.read),
    archived: Math.max(0, stats.archived + archivedDelta),
  };
}

function sortConversations(conversations: ConversationRecord[]) {
  return [...conversations].sort((left, right) => {
    const leftTime = left.updatedAt ?? left.createdAt;
    const rightTime = right.updatedAt ?? right.createdAt;
    return rightTime.localeCompare(leftTime);
  });
}

export function ConversationsPanel({
  initialDashboard,
  twilioProviderMode,
}: ConversationsPanelProps) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [selectedId, setSelectedId] = useState(
    initialDashboard.conversations[0]?.id ?? "",
  );
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<FilterMode>("all");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => new Date());
  const [isPending, setIsPending] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const refreshSequenceRef = useRef(0);
  const modeRef = useRef(mode);
  const queryRef = useRef(query);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const selected = useMemo(
    () =>
      dashboard.conversations.find((conversation) => conversation.id === selectedId) ??
      dashboard.conversations[0],
    [dashboard.conversations, selectedId],
  );

  function isTimelineNearBottom() {
    const timeline = timelineRef.current;
    if (!timeline) {
      return true;
    }

    return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
  }

  function scrollTimelineToBottom(behavior: ScrollBehavior = "auto") {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    if (timeline.scrollHeight <= timeline.clientHeight + 1) {
      timeline.scrollTop = 0;
      return;
    }

    timeline.scrollTo({ top: timeline.scrollHeight, behavior });
  }

  useEffect(() => {
    requestAnimationFrame(() => scrollTimelineToBottom("auto"));
  }, [selected?.id]);

  const refresh = useCallback(async (
    nextMode?: FilterMode,
    nextQuery?: string,
    options: { force?: boolean; silent?: boolean; suppressPollError?: boolean } = {},
  ) => {
    const requestedMode = nextMode ?? modeRef.current;
    const requestedQuery = nextQuery ?? queryRef.current;
    if (refreshPromiseRef.current && !options.force) {
      return refreshPromiseRef.current;
    }

    if (refreshPromiseRef.current && options.force) {
      refreshAbortRef.current?.abort();
      await refreshPromiseRef.current.catch(() => undefined);
    }

    const controller = new AbortController();
    const refreshSequence = ++refreshSequenceRef.current;
    const shouldAutoScroll = isTimelineNearBottom();
    const params = new URLSearchParams();
    if (requestedMode !== "all") {
      params.set("mode", requestedMode);
    }
    if (requestedQuery.trim()) {
      params.set("query", requestedQuery.trim());
    }

    const promise = (async () => {
      const response = await fetch(`/api/conversations?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data = (await response.json()) as ConversationDashboard & {
        ok?: boolean;
        error?: string;
      };

      if (!response.ok || data.ok === false) {
        throw new Error(data.error ?? "No se pudo cargar el panel.");
      }

      if (refreshSequence !== refreshSequenceRef.current) {
        return;
      }

      setDashboard(data);
      setSelectedId((current) =>
        data.conversations.some((conversation) => conversation.id === current)
          ? current
          : data.conversations[0]?.id ?? "",
      );
      setPollError("");
      setLastUpdatedAt(new Date());
      if (shouldAutoScroll) {
        requestAnimationFrame(() => scrollTimelineToBottom(options.silent ? "auto" : "smooth"));
      }
    })()
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }

        if (options.silent) {
          if (!options.suppressPollError) {
            setPollError("No se pudo actualizar en segundo plano.");
          }
          return;
        }

        throw caught;
      })
      .finally(() => {
        if (refreshPromiseRef.current === promise) {
          refreshPromiseRef.current = null;
        }
        if (refreshAbortRef.current === controller) {
          refreshAbortRef.current = null;
        }
      });

    refreshPromiseRef.current = promise;
    refreshAbortRef.current = controller;
    return promise;
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh(undefined, undefined, { silent: true });
    }, CONVERSATION_PANEL_POLL_INTERVAL_MS);

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") {
        void refresh(undefined, undefined, { force: true, silent: true });
      }
    }

    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      refreshAbortRef.current?.abort();
    };
  }, [refresh]);

  function run(action: () => Promise<void>) {
    setError("");
    setIsPending(true);
    void action()
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Ha fallado la acción.");
      })
      .finally(() => setIsPending(false));
  }

  function changeMode(nextMode: FilterMode) {
    setMode(nextMode);
    run(() => refresh(nextMode, query, { force: true }));
  }

  function changePrimaryView(nextView: "active" | "archived") {
    const nextMode = nextView === "archived" ? "archived" : "all";
    setMode(nextMode);
    run(() => refresh(nextMode, query, { force: true }));
  }

  function search(nextQuery: string) {
    setQuery(nextQuery);
    run(() => refresh(mode, nextQuery, { force: true }));
  }

  async function postAction(path: string, body?: unknown, method = "POST") {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : method === "DELETE" ? undefined : "{}",
    });
    const data = await readJsonOrEmpty(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error ?? "La acción no se pudo completar.");
    }

    return data;
  }

  function reconcileConversationMutation(
    previous: ConversationRecord,
    next: ConversationRecord,
    nextMode = modeRef.current,
    nextQuery = queryRef.current,
  ) {
    refreshAbortRef.current?.abort();
    refreshSequenceRef.current += 1;

    let preferredSelectedId: string | undefined;
    setDashboard((currentDashboard) => {
      const existing = currentDashboard.conversations.find(
        (conversation) => conversation.id === next.id,
      );
      const previousForStats = existing ?? previous;
      const withoutMutated = currentDashboard.conversations.filter(
        (conversation) => conversation.id !== next.id,
      );
      const shouldShow =
        conversationMatchesMode(next, nextMode) && conversationMatchesQuery(next, nextQuery);
      const conversations = sortConversations(
        shouldShow ? [...withoutMutated, next] : withoutMutated,
      );

      preferredSelectedId = conversations[0]?.id ?? "";

      return {
        ...currentDashboard,
        conversations,
        stats: reconcileStats(currentDashboard.stats, previousForStats, next),
      };
    });
    setSelectedId((current) =>
      current === next.id ? preferredSelectedId ?? "" : current,
    );
    setPollError("");
    setLastUpdatedAt(new Date());
  }

  function setConversationMode(conversation: ConversationRecord, nextMode: ConversationMode) {
    if (conversation.mode === nextMode) {
      return;
    }

    run(async () => {
      await postAction(
        `/api/conversations/${encodeURIComponent(conversation.id)}/mode`,
        { mode: nextMode },
      );
      await refresh(undefined, undefined, { force: true });
    });
  }

  function markRead(conversation: ConversationRecord) {
    if (conversation.unreadCount === 0 && !conversation.humanRequested) {
      return;
    }

    run(async () => {
      await postAction(
        `/api/conversations/${encodeURIComponent(conversation.id)}/mark-read`,
      );
      await refresh(undefined, undefined, { force: true });
    });
  }

  function sendReply(conversation: ConversationRecord) {
    const body = reply.trim();
    if (!body) {
      setError("Escribe una respuesta antes de enviar.");
      return;
    }

    run(async () => {
      await postAction(
        `/api/conversations/${encodeURIComponent(conversation.id)}/reply`,
        { body },
      );
      setReply("");
      await refresh(undefined, undefined, { force: true });
    });
  }

  function requestVideoMock(conversation: ConversationRecord) {
    run(async () => {
      await postAction(
        `/api/conversations/${encodeURIComponent(conversation.id)}/media-mock`,
        { kind: "video" },
      );
      await refresh(undefined, undefined, { force: true });
    });
  }

  function archiveSelectedConversation(conversation: ConversationRecord) {
    run(async () => {
      const result = await postAction(
        `/api/conversations/${encodeURIComponent(conversation.id)}/archive`,
        { reason: "inbox_cleanup" },
      );
      if (result.conversation) {
        reconcileConversationMutation(conversation, result.conversation);
      }
      await refresh(undefined, undefined, {
        force: true,
        silent: true,
        suppressPollError: true,
      });
    });
  }

  function unarchiveSelectedConversation(conversation: ConversationRecord) {
    run(async () => {
      const result = await postAction(
        `/api/conversations/${encodeURIComponent(conversation.id)}/archive`,
        undefined,
        "DELETE",
      );
      setMode("all");
      if (result.conversation) {
        reconcileConversationMutation(conversation, result.conversation, "all");
      }
      await refresh("all", undefined, {
        force: true,
        silent: true,
        suppressPollError: true,
      });
    });
  }

  return (
    <section className="conversations-panel" aria-busy={isPending}>
      <div className="conversation-panel-toolbar">
        <div className="conversation-panel-actions">
          <Link href="/admin/registro-entrada" className="conversation-top-link">
            Registro de entrada
            <ExternalLink size={14} />
          </Link>
        </div>
        <details className="conversation-technical-status">
          <summary>Estado técnico</summary>
          <span className={`conversation-transport conversation-transport-${twilioProviderMode}`}>
            <Circle size={10} fill="currentColor" />
            Proveedor: Twilio WhatsApp · {formatProviderMode(twilioProviderMode)}
          </span>
        </details>
      </div>

      <div className="conversation-workspace">
        <aside className="conversation-sidebar">
          <div className="conversation-sidebar-brand">
            <div>
              <strong>{mode === "archived" ? "Histórico de conversaciones" : "Inbox WhatsApp"}</strong>
              <small>
                {mode === "archived"
                  ? "Conversaciones archivadas"
                  : "Reservas y handoffs"}
              </small>
            </div>
          </div>

          <div className="conversation-primary-tabs" role="tablist" aria-label="Vista del inbox">
            <button
              type="button"
              className={mode !== "archived" ? "is-active" : ""}
              onClick={() => changePrimaryView("active")}
              disabled={isPending && mode !== "archived"}
            >
              Inbox activo
              <span>{dashboard.stats.total}</span>
            </button>
            <button
              type="button"
              className={mode === "archived" ? "is-active" : ""}
              onClick={() => changePrimaryView("archived")}
              disabled={isPending && mode === "archived"}
            >
              Archivadas / Histórico
              <span>{dashboard.stats.archived}</span>
            </button>
          </div>

          <div className="conversation-metrics">
            <Metric label="Pendientes" value={dashboard.stats.pending} />
            <Metric label="Humano" value={dashboard.stats.human} />
            <Metric label="Activas" value={dashboard.stats.total} />
            <Metric label="Leídas" value={dashboard.stats.read} />
          </div>

          <div className="conversation-toolbar">
            <label className="conversation-search">
              <Search size={17} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => search(event.target.value)}
                placeholder="Buscar teléfono, nombre o mascota"
              />
            </label>
            <button
              className="conversation-refresh-button"
              type="button"
              onClick={() => run(() => refresh())}
              title="Actualizar"
              aria-label="Actualizar"
              disabled={isPending}
            >
              <RefreshCcw size={17} />
              Actualizar
            </button>
          </div>
          <div className="conversation-poll-status" role="status" aria-live="polite">
            {pollError || `Actualizado ${lastUpdatedAt.toLocaleTimeString("es-ES", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}`}
          </div>

          {mode !== "archived" ? (
            <div className="conversation-tabs" role="tablist" aria-label="Filtros">
              {filters.map((filter) => (
                <button
                  key={filter.value}
                  className={mode === filter.value ? "is-active" : ""}
                  type="button"
                  onClick={() => changeMode(filter.value)}
                  disabled={isPending && mode === filter.value}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          ) : null}
          {mode === "archived" ? (
            <div className="conversation-archive-note">
              Viendo Archivadas / Histórico. Puedes restaurar una conversación para devolverla al inbox activo.
            </div>
          ) : null}

          <div className="conversation-list">
            {isPending ? (
              <div className="conversation-loading">Actualizando inbox...</div>
            ) : null}
            {dashboard.conversations.length === 0 ? (
              <div className="conversation-empty">
                <strong>
                  {mode === "archived"
                    ? "No hay conversaciones archivadas."
                    : "No hay conversaciones todavía."}
                </strong>
                <span>
                  {mode === "archived"
                    ? "Cuando archives conversaciones, aparecerán en este histórico."
                    : "Cuando entre un WhatsApp, aparecerá aquí sin cargar conversaciones demo."}
                </span>
              </div>
            ) : (
              dashboard.conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`conversation-list-item ${
                    selected?.id === conversation.id ? "is-selected" : ""
                  }`}
                  type="button"
                  onClick={() => setSelectedId(conversation.id)}
                >
                  <span className="conversation-list-main">
                    <span className="conversation-list-title-row">
                      <strong>{conversationTitle(conversation)}</strong>
                      <time>{formatDate(conversation.updatedAt)}</time>
                    </span>
                    <span className="conversation-list-subtitle">
                      {conversationSubtitle(conversation)}
                    </span>
                    <ClientBadges conversation={conversation} compact />
                    <small>{conversationPreview(conversation)}</small>
                  </span>
                  <span className="conversation-list-meta">
                    <ModeBadge mode={conversation.mode} />
                    {conversation.unreadCount > 0 ? (
                      <b>{conversation.unreadCount}</b>
                    ) : null}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <div className="conversation-detail">
          {selected ? (
            <>
              <header className="conversation-detail-header">
                <div className="conversation-contact-summary">
                  <div className="conversation-contact-title-row">
                    <h2>{conversationTitle(selected)}</h2>
                    <ModeBadge mode={selected.mode} />
                    <ClientBadges conversation={selected} compact />
                  </div>
                  <span>
                    {selected.phoneE164}
                    {selected.petName ? ` · Mascota: ${selected.petName}` : ""}
                  </span>
                </div>
                <div className="conversation-actions">
                  {selected.unreadCount > 0 || selected.humanRequested ? (
                    <button
                      type="button"
                      onClick={() => markRead(selected)}
                      disabled={isPending}
                    >
                      <CheckCheck size={16} />
                      Marcar como leído
                    </button>
                  ) : null}
                  {selected.archivedAt ? (
                    <button
                      type="button"
                      onClick={() => unarchiveSelectedConversation(selected)}
                      disabled={isPending}
                    >
                      <RefreshCcw size={16} />
                      Restaurar
                    </button>
                  ) : selected.mode === "bot" ? (
                    <button
                      type="button"
                      onClick={() => setConversationMode(selected, "human")}
                      disabled={isPending}
                    >
                      <UserRound size={16} />
                      Tomar conversación
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConversationMode(selected, "bot")}
                      disabled={isPending}
                    >
                      <Bot size={16} />
                      Devolver al bot
                    </button>
                  )}
                  {!selected.archivedAt ? (
                    <button
                      type="button"
                      onClick={() => archiveSelectedConversation(selected)}
                      disabled={isPending}
                    >
                      <Archive size={16} />
                      Archivar
                    </button>
                  ) : null}
                </div>
              </header>

              <details className="conversation-context-details">
                <summary>Contexto</summary>
                <div className="conversation-status-row">
                  <span>{selected.humanRequested ? "Handoff solicitado" : "Sin handoff"}</span>
                  <span>{selected.unreadCount} no leídos</span>
                  <span>{selected.channel ?? selected.sourceType}</span>
                  <span>{selected.messages.length} mensajes</span>
                  <span>{selected.events.length} eventos</span>
                  <span>Última actividad {formatDate(selected.updatedAt)}</span>
                  {selected.clientEmail ? <span>{selected.clientEmail}</span> : null}
                  {selected.reservationId ? <span>Reserva: {selected.reservationId}</span> : null}
                  {selected.assignedAgent ? <span>{selected.assignedAgent}</span> : null}
                  {selected.clientName ? <span>Nombre CLIENTES: {selected.clientName}</span> : null}
                  {selected.displayName ? <span>Nombre WhatsApp: {selected.displayName}</span> : null}
                  <span>Nombre visible: {visibleNameSource(selected)}</span>
                  <span>Match directorio: {matchTypeLabel(selected)}</span>
                  <span>Confianza: {selected.clientConfidence ?? "none"}</span>
                  <span>Cliente: {selected.clientStatus ?? "unknown"}</span>
                  {isStrongDirectoryMatch(selected) && selected.clientMatchType === "phone" ? (
                    <span>Cliente reconocido automáticamente por teléfono</span>
                  ) : null}
                  {selected.clientDirectoryUpsertKind ? (
                    <span>
                      {clientDirectoryUpsertLabel(selected)}
                      {selected.clientDirectoryUpsertWarning ? ` · ${selected.clientDirectoryUpsertWarning}` : ""}
                    </span>
                  ) : null}
                  <span>Estado reserva: {reservationStatusLabel(selected)}</span>
                  <span>Disponibilidad: {availabilityLabel(selected)}</span>
                  {selected.reservationFlow?.email ? <span>Email recogido: {selected.reservationFlow.email}</span> : null}
                  {selected.reservationFlow?.petName ? <span>Mascota: {selected.reservationFlow.petName}</span> : null}
                  {selected.reservationFlow?.petNames?.length ? (
                    <span>Nombres mascota/s: {selected.reservationFlow.petNames.join(", ")}</span>
                  ) : null}
                  {selected.reservationFlow?.petCount ? <span>Perros: {selected.reservationFlow.petCount}</span> : null}
                  {selected.reservationFlow?.petCountInference ? (
                    <span>Perros inferidos por: {selected.reservationFlow.petCountInference}</span>
                  ) : null}
                  {selected.reservationFlow?.petCountInconsistency ? (
                    <span>
                      Inconsistencia mascotas: {selected.reservationFlow.petCountInconsistency.nameCount} nombres /
                      {selected.reservationFlow.petCountInconsistency.statedCount} perros
                    </span>
                  ) : null}
                  {selected.reservationFlow?.checkInDate ? (
                    <span>
                      Entrada: {selected.reservationFlow.checkInDate}
                      {selected.reservationFlow.checkInTime ? ` ${selected.reservationFlow.checkInTime}` : ""}
                    </span>
                  ) : null}
                  {selected.reservationFlow?.checkOutDate ? (
                    <span>
                      Salida: {selected.reservationFlow.checkOutDate}
                      {selected.reservationFlow.checkOutTime ? ` ${selected.reservationFlow.checkOutTime}` : ""}
                    </span>
                  ) : null}
                  {selected.reservationFlow?.price !== undefined ? (
                    <span>
                      Precio: {selected.reservationFlow.price} € · priceSource=
                      {selected.reservationFlow.priceSource ?? "pending"}
                    </span>
                  ) : null}
                  <span>Visita: {visitLabel(selected.reservationFlow?.wantsVisit)}</span>
                  {isStrongDirectoryMatch(selected) && selected.clientSheetName && selected.clientSheetRow ? (
                    <span>CLIENTES · fila {selected.clientSheetRow}</span>
                  ) : null}
                  {selected.clientMatchType === "name" ? (
                    <span>Coincidencia por nombre, revisar antes de tratar como cliente habitual.</span>
                  ) : null}
                </div>
              </details>

              {error ? <div className="conversation-error">{error}</div> : null}
              {selected.clientWarnings?.length ? (
                <div className="conversation-client-alerts">
                  {selected.clientWarnings.map((warning) => (
                    <span key={warning}>{warning}</span>
                  ))}
                </div>
              ) : null}
              <div className="conversation-timeline" ref={timelineRef}>
                {[...selected.messages, ...selected.events]
                  .filter((item) =>
                    "eventType" in item
                      ? shouldShowTimelineEvent(item.eventType)
                      : true,
                  )
                  .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
                  .map((item) =>
                    "body" in item ? (
                      <div
                        key={item.id}
                        className={`conversation-message is-${item.direction} from-${item.senderType}`}
                      >
                        <span>
                          {formatSender(item.senderType)} · {formatDate(item.createdAt)}
                        </span>
                        <p>{item.body}</p>
                      </div>
                    ) : (
                      <div key={item.id} className="conversation-event">
                        <MessageSquareText size={14} />
                        <span>
                          {formatEventType(item.eventType)} · {formatDate(item.createdAt)}
                        </span>
                      </div>
                    ),
                  )}
              </div>

              <div className="conversation-composer">
                <label className="conversation-composer-field">
                  <span>Respuesta manual del equipo</span>
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder="Escribe una respuesta clara para WhatsApp"
                    rows={3}
                    maxLength={1200}
                    disabled={isPending}
                  />
                </label>
                <div className="conversation-composer-actions">
                  <button
                    className="conversation-send-button"
                    type="button"
                    onClick={() => sendReply(selected)}
                    disabled={isPending || !reply.trim() || Boolean(selected.archivedAt)}
                  >
                    <Send size={17} />
                    Enviar
                  </button>
                  <button
                    className="conversation-video-mock-button"
                    type="button"
                    onClick={() => requestVideoMock(selected)}
                    disabled={isPending || Boolean(selected.archivedAt)}
                    title="Mock: requiere almacenamiento de archivos"
                  >
                    <Film size={17} />
                    Adjuntar vídeo
                    <small>Mock</small>
                  </button>
                </div>
                <small className="conversation-composer-hint">
                  {twilioProviderMode === "mock"
                    ? "Modo demo: se guarda en el timeline, no sale por WhatsApp real."
                    : twilioProviderMode === "sandbox"
                      ? "Sandbox: el destinatario debe haberse unido antes de responder."
                      : "Twilio real activo: revisa el mensaje antes de enviarlo."}
                </small>
              </div>
            </>
          ) : (
            <div className="conversation-empty conversation-empty-large">
              Selecciona o crea una conversación demo para empezar.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatProviderMode(mode: ConversationsPanelProps["twilioProviderMode"]) {
  const labels: Record<ConversationsPanelProps["twilioProviderMode"], string> = {
    mock: "Mock",
    real: "Real",
    sandbox: "Sandbox",
  };

  return labels[mode];
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="conversation-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ModeBadge({ mode }: { mode: ConversationMode }) {
  return (
    <span className={`conversation-mode conversation-mode-${mode}`}>
      {mode === "human" ? "Humano" : "Bot"}
    </span>
  );
}

function ClientBadges({
  conversation,
  compact = false,
}: {
  conversation: ConversationRecord;
  compact?: boolean;
}) {
  const status = conversation.clientStatus ?? "unknown";
  const strongDirectoryMatch = isStrongDirectoryMatch(conversation);
  const label =
    status === "known" && strongDirectoryMatch
      ? "Cliente habitual"
      : status === "ambiguous" && conversation.clientMatchType === "name"
        ? "Posible coincidencia"
        : status === "ambiguous" || status === "blocked"
          ? "Revisión manual"
          : "Nuevo contacto";
  const visualStatus =
    status === "known" && !strongDirectoryMatch ? "unknown" : status;

  return (
    <span className={`conversation-client-badges ${compact ? "is-compact" : ""}`}>
      <span className={`conversation-client-badge conversation-client-${visualStatus}`}>
        {label}
      </span>
      {strongDirectoryMatch ? (
        <span className="conversation-client-badge conversation-client-source">
          Directorio
        </span>
      ) : null}
    </span>
  );
}

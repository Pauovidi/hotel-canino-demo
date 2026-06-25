import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const DAY_MS = 24 * 60 * 60 * 1000;

export function readBooleanEnv(env, names, fallback) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    }
  }
  return fallback;
}

export function readNumberEnv(env, names, fallback) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }
  return fallback;
}

export function readScheduledMessagesConfig(env = process.env) {
  return {
    scheduledMessagesEnabled: readBooleanEnv(env, ["HOTEL_SCHEDULED_MESSAGES_ENABLED"], false),
    scheduledMessagesDryRun: readBooleanEnv(env, ["HOTEL_SCHEDULED_MESSAGES_DRY_RUN"], true),
    reservationReminderEnabled: readBooleanEnv(
      env,
      ["HOTEL_RESERVATION_REMINDER_ENABLED", "HOTEL_RESERVATION_REMINDERS_ENABLED"],
      false,
    ),
    reservationReminderDryRun: readBooleanEnv(
      env,
      ["HOTEL_RESERVATION_REMINDER_DRY_RUN", "HOTEL_RESERVATION_REMINDERS_DRY_RUN"],
      true,
    ),
    reservationReminderDaysBefore: Math.max(
      1,
      readNumberEnv(
        env,
        ["HOTEL_RESERVATION_REMINDER_DAYS_BEFORE", "HOTEL_RESERVATION_REMINDER_LEAD_DAYS"],
        5,
      ),
    ),
    postStayFollowupEnabled: readBooleanEnv(
      env,
      ["HOTEL_POST_STAY_FOLLOWUP_ENABLED", "HOTEL_POST_STAY_FOLLOWUPS_ENABLED"],
      false,
    ),
    postStayFollowupDryRun: readBooleanEnv(
      env,
      ["HOTEL_POST_STAY_FOLLOWUP_DRY_RUN", "HOTEL_POST_STAY_FOLLOWUPS_DRY_RUN"],
      true,
    ),
    postStayFollowupDaysAfter: Math.max(
      0,
      readNumberEnv(env, ["HOTEL_POST_STAY_FOLLOWUP_DAYS_AFTER"], 1),
    ),
    postStayFollowupOnlyNewClients: readBooleanEnv(
      env,
      ["HOTEL_POST_STAY_FOLLOWUP_ONLY_NEW_CLIENTS"],
      true,
    ),
  };
}

export function safeErrorCode(error) {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code).slice(0, 80);
  }
  return error instanceof Error ? error.name.slice(0, 80) : undefined;
}

export function writeJsonResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

export function writeJsonError(error, fallbackCode = "job_failed") {
  console.error(
    JSON.stringify(
      {
        ok: false,
        errorName: error instanceof Error ? error.name : "UnknownError",
        safeErrorCode: safeErrorCode(error) ?? fallbackCode,
        missingRequiredMigrations:
          error && typeof error === "object" && Array.isArray(error.missingRequiredMigrations)
            ? error.missingRequiredMigrations
            : undefined,
      },
      null,
      2,
    ),
  );
}

export function createPoolFromEnv(env = process.env) {
  if (!env.DATABASE_URL?.trim()) {
    const error = new Error("DATABASE_URL is required for this enabled job.");
    error.code = "database_url_missing";
    throw error;
  }

  const { Pool } = pg;
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: Number.parseInt(env.DATABASE_POOL_MAX ?? "5", 10),
  });
}

export async function closePool(pool) {
  await pool?.end().catch(() => undefined);
}

function normalizeDateKey(value) {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function addDaysDateKey(now, offsetDays) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function parsePayload(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function petNamesFromPayload(payload, fallbackPetName) {
  if (Array.isArray(payload.petNames)) {
    const names = payload.petNames.map((name) => String(name).trim()).filter(Boolean);
    if (names.length > 0) {
      return names;
    }
  }
  if (payload.petName || fallbackPetName) {
    return [String(payload.petName ?? fallbackPetName).trim()].filter(Boolean);
  }
  return ["tu mascota"];
}

function fallbackName(value) {
  return String(value ?? "").trim() || "familia";
}

function formatPetNames(petNames) {
  return petNames.map((petName) => String(petName).trim()).filter(Boolean).join(", ");
}

function formatDateForMessage(value) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function buildPrearrivalReminderMessage(reservation) {
  const date = formatDateForMessage(reservation.checkInDate);
  const entryText = reservation.checkInTime ? `${date} a las ${reservation.checkInTime}` : date;
  return [
    `Estimado/a ${fallbackName(reservation.ownerName)}.`,
    "Le recordamos que tiene una reserva en nuestro Hotel Canino.",
    `Para sus mascotas: *${formatPetNames(reservation.petNames)}*`,
    `El dia ${entryText}`,
    "Por favor, avisenos con antelacion si no puede asistir o necesita modificar la reserva y cual sera su hora de llegada. Gracias.",
    "Saludos,",
    "Somosmuyperros",
  ].join("\n");
}

function buildPostStayFollowupMessage(reservation) {
  return `Buenos dias ${fallbackName(reservation.ownerName)}, que tal ${formatPetNames(
    reservation.petNames,
  )} despues de su estancia con nosotros, todo bien?`;
}

function rowToReservation(row) {
  const payload = parsePayload(row.payload);
  const checkInDate = normalizeDateKey(payload.checkInDate ?? row.entry_date);
  const checkOutDate = normalizeDateKey(payload.checkOutDate ?? row.exit_date);
  return {
    reservationId: String(payload.reservationId ?? row.reservation_id ?? "").trim(),
    status: String(payload.status ?? row.status ?? "").trim(),
    workflowState: payload.workflowState ? String(payload.workflowState) : undefined,
    ownerName: payload.ownerName ? String(payload.ownerName) : row.owner_name ? String(row.owner_name) : undefined,
    petName: payload.petName ? String(payload.petName) : row.pet_name ? String(row.pet_name) : undefined,
    petNames: petNamesFromPayload(payload, row.pet_name),
    phone: payload.phone ? String(payload.phone) : row.phone_e164 ? String(row.phone_e164) : undefined,
    checkInDate,
    checkInTime: payload.checkInTime ? String(payload.checkInTime) : undefined,
    checkOutDate,
    clientKind: payload.clientKind ? String(payload.clientKind) : undefined,
    prearrivalReminderSentAt: payload.prearrivalReminderSentAt
      ? String(payload.prearrivalReminderSentAt)
      : undefined,
    postStayFollowupSentAt: payload.postStayFollowupSentAt
      ? String(payload.postStayFollowupSentAt)
      : undefined,
  };
}

function isConfirmed(reservation) {
  return reservation.status === "confirmada" || reservation.workflowState === "confirmed";
}

function hashPhone(value) {
  if (!value?.trim()) {
    return undefined;
  }
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

function sanitizePayload(payload) {
  const next = { ...payload };
  delete next.to;
  delete next.phone;
  delete next.phoneE164;
  return next;
}

async function loadReservationsForJob(pool, kind, now, config) {
  const targetDate =
    kind === "prearrival"
      ? addDaysDateKey(now, config.reservationReminderDaysBefore)
      : addDaysDateKey(now, -config.postStayFollowupDaysAfter);
  const dateColumn = kind === "prearrival" ? "entry_date" : "exit_date";
  const result = await pool.query(
    `SELECT reservation_id, status, owner_name, pet_name, phone_e164, entry_date, exit_date, payload
     FROM hotel_reservations
     WHERE ${dateColumn} = $1::date
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
    [targetDate],
  );
  return result.rows.map(rowToReservation);
}

function selectCandidates(kind, reservations, now, config) {
  return reservations
    .filter((reservation) => reservation.reservationId)
    .filter((reservation) => isConfirmed(reservation))
    .filter((reservation) => {
      if (kind === "prearrival") {
        return !reservation.prearrivalReminderSentAt;
      }
      return !reservation.postStayFollowupSentAt;
    })
    .filter((reservation) => {
      if (kind !== "post_stay") {
        return true;
      }
      return !config.postStayFollowupOnlyNewClients || reservation.clientKind === "new";
    })
    .map((reservation) => {
      const type =
        kind === "prearrival" ? "reservation_prearrival_reminder" : "post_stay_followup";
      const dryRun =
        config.scheduledMessagesDryRun ||
        !config.scheduledMessagesEnabled ||
        (kind === "prearrival"
          ? config.reservationReminderDryRun
          : config.postStayFollowupDryRun);
      const message =
        kind === "prearrival"
          ? buildPrearrivalReminderMessage(reservation)
          : buildPostStayFollowupMessage(reservation);
      return {
        type,
        reservationId: reservation.reservationId,
        phone: reservation.phone,
        payload: {
          message,
          petName: reservation.petName,
          petNames: reservation.petNames,
          scheduledBy: kind === "prearrival" ? "reservation-prearrival" : "post-stay",
        },
        scheduledAt: now.toISOString(),
        dedupeKey: `${reservation.reservationId}:${type}`,
        dryRun,
      };
    });
}

async function upsertScheduledMessage(pool, candidate, now) {
  const id = `sched_${randomUUID()}`;
  const result = await pool.query(
    `INSERT INTO hotel_scheduled_messages (
      id, type, reservation_id, channel, external_user_id, phone_hash, payload,
      scheduled_at, status, attempts, max_attempts, last_error_code, dedupe_key,
      dry_run, created_at, updated_at, sent_at
    ) VALUES ($1,$2,$3,'whatsapp',$4,$5,$6::jsonb,$7,'pending',0,3,NULL,$8,$9,$10,$10,NULL)
    ON CONFLICT (dedupe_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      scheduled_at = CASE
        WHEN hotel_scheduled_messages.status IN ('pending','dry_run','failed','skipped')
          THEN EXCLUDED.scheduled_at
        ELSE hotel_scheduled_messages.scheduled_at
      END,
      dry_run = EXCLUDED.dry_run,
      updated_at = EXCLUDED.updated_at
    RETURNING id`,
    [
      id,
      candidate.type,
      candidate.reservationId,
      candidate.phone ?? null,
      hashPhone(candidate.phone) ?? null,
      JSON.stringify(sanitizePayload(candidate.payload)),
      candidate.scheduledAt,
      candidate.dedupeKey,
      candidate.dryRun,
      now.toISOString(),
    ],
  );
  return result.rowCount === 1;
}

export async function runReservationQueueJob(kind, env = process.env) {
  const config = readScheduledMessagesConfig(env);
  const enabled =
    kind === "prearrival"
      ? config.reservationReminderEnabled
      : config.postStayFollowupEnabled;
  if (!enabled) {
    return {
      ok: true,
      dryRunOnly: true,
      candidateCount: 0,
      queued: 0,
      reason: "disabled",
    };
  }

  const now = new Date();
  const pool = createPoolFromEnv(env);
  try {
    const reservations = await loadReservationsForJob(pool, kind, now, config);
    const candidates = selectCandidates(kind, reservations, now, config);
    let queued = 0;
    for (const candidate of candidates) {
      if (await upsertScheduledMessage(pool, candidate, now)) {
        queued += 1;
      }
    }
    return {
      ok: true,
      dryRunOnly: candidates.every((candidate) => candidate.dryRun),
      candidateCount: candidates.length,
      queued,
    };
  } finally {
    await closePool(pool);
  }
}

async function claimDueMessages(pool, now, limit) {
  const result = await pool.query(
    `SELECT *
     FROM hotel_scheduled_messages
     WHERE status = 'pending'
       AND scheduled_at <= $1
     ORDER BY scheduled_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows;
}

async function markScheduledMessage(pool, input) {
  await pool.query(
    `UPDATE hotel_scheduled_messages
     SET status = $2,
         updated_at = $3,
         attempts = attempts + 1,
         last_error_code = $4,
         sent_at = $5
     WHERE id = $1`,
    [
      input.id,
      input.status,
      input.now.toISOString(),
      input.lastErrorCode ?? null,
      input.sentAt ?? null,
    ],
  );
}

function asWhatsAppAddress(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

async function sendTwilioWhatsAppText(input, env) {
  const mock =
    env.HOTEL_CONVERSATIONS_MOCK_TWILIO !== "false" ||
    env.TWILIO_WHATSAPP_PROVIDER_MODE !== "real";
  if (mock) {
    return { ok: true, mode: "mock" };
  }

  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const from = env.TWILIO_WHATSAPP_FROM?.trim();
  if (!accountSid || !authToken || (!messagingServiceSid && !from)) {
    return { ok: false, mode: "real", error: "twilio_config_missing" };
  }

  const form = new URLSearchParams({
    To: asWhatsAppAddress(input.to),
    Body: input.body,
  });
  if (messagingServiceSid) {
    form.set("MessagingServiceSid", messagingServiceSid);
  } else {
    form.set("From", asWhatsAppAddress(from));
  }
  if (env.TWILIO_STATUS_CALLBACK_URL?.trim()) {
    form.set("StatusCallback", env.TWILIO_STATUS_CALLBACK_URL.trim());
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );
  if (!response.ok) {
    return { ok: false, mode: "real", error: `twilio_http_${response.status}` };
  }
  const body = await response.json().catch(() => ({}));
  return { ok: true, mode: "real", sid: typeof body.sid === "string" ? body.sid : undefined };
}

export async function runDispatchScheduledMessages(env = process.env) {
  const config = readScheduledMessagesConfig(env);
  if (!env.DATABASE_URL?.trim()) {
    if (config.scheduledMessagesEnabled) {
      const error = new Error("DATABASE_URL is required for scheduled message dispatch.");
      error.code = "database_url_missing";
      throw error;
    }
    return {
      ok: true,
      dryRunOnly: true,
      due: 0,
      sent: 0,
      dryRun: 0,
      failed: 0,
      skipped: 0,
      reason: "database_url_missing",
    };
  }

  const now = new Date();
  const pool = createPoolFromEnv(env);
  const result = {
    ok: true,
    dryRunOnly: config.scheduledMessagesDryRun || !config.scheduledMessagesEnabled,
    due: 0,
    sent: 0,
    dryRun: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    const due = await claimDueMessages(
      pool,
      now,
      Math.max(1, readNumberEnv(env, ["HOTEL_SCHEDULED_MESSAGES_DISPATCH_LIMIT"], 50)),
    );
    result.due = due.length;

    for (const message of due) {
      const payload = parsePayload(message.payload);
      const recipient =
        (message.external_user_id ? String(message.external_user_id) : undefined) ??
        (typeof payload.to === "string" ? payload.to : undefined);
      const body = typeof payload.message === "string" ? payload.message : undefined;
      const dryRun = result.dryRunOnly || Boolean(message.dry_run);

      if (!recipient || !body) {
        await markScheduledMessage(pool, {
          id: message.id,
          status: "skipped",
          now,
          lastErrorCode: "missing_recipient_or_body",
        });
        result.skipped += 1;
        continue;
      }

      if (dryRun) {
        await markScheduledMessage(pool, {
          id: message.id,
          status: "dry_run",
          now,
          lastErrorCode: "dry_run",
        });
        result.dryRun += 1;
        continue;
      }

      let sent;
      try {
        sent = await sendTwilioWhatsAppText({ to: recipient, body }, env);
      } catch (error) {
        sent = { ok: false, mode: "real", error: safeErrorCode(error) ?? "send_failed" };
      }
      if (sent.ok && sent.mode === "real") {
        await markScheduledMessage(pool, {
          id: message.id,
          status: "sent",
          now,
          sentAt: now.toISOString(),
        });
        result.sent += 1;
      } else if (sent.ok && sent.mode === "mock") {
        await markScheduledMessage(pool, {
          id: message.id,
          status: "dry_run",
          now,
          lastErrorCode: "mock_sender",
        });
        result.dryRun += 1;
      } else {
        await markScheduledMessage(pool, {
          id: message.id,
          status: "failed",
          now,
          lastErrorCode: sent.error?.slice(0, 80) ?? "send_failed",
        });
        result.failed += 1;
      }
    }

    result.ok = result.failed === 0;
    return result;
  } finally {
    await closePool(pool);
  }
}

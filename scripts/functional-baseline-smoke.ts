#!/usr/bin/env node

import { createStaticClientDirectory } from "@/lib/hotel/clients";
import { buildStatelessTemplatePreviewResult } from "@/lib/hotel/conversations/template-preview";
import {
  handleInboundWhatsApp,
  setConversationMode,
} from "@/lib/hotel/conversations/service";
import {
  createEmptyConversationSnapshot,
  filterConversationRecords,
  type ConversationStore,
} from "@/lib/hotel/conversations/store";
import type {
  Conversation,
  ConversationEvent,
  ConversationListFilters,
  ConversationRecord,
  ConversationSnapshot,
  Message,
} from "@/lib/hotel/conversations/types";

class MemoryConversationStore implements ConversationStore {
  private snapshot: ConversationSnapshot = createEmptyConversationSnapshot();

  async load(): Promise<ConversationSnapshot> {
    return structuredClone(this.snapshot);
  }

  async save(snapshot: ConversationSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async list(filters?: ConversationListFilters): Promise<ConversationRecord[]> {
    return filterConversationRecords(this.snapshot.conversations, filters);
  }

  async getById(id: string): Promise<ConversationRecord | undefined> {
    return structuredClone(this.snapshot.conversations.find((record) => record.id === id));
  }

  async getByPhone(phoneNormalized: string): Promise<ConversationRecord | undefined> {
    return structuredClone(
      this.snapshot.conversations.find((record) => record.phoneNormalized === phoneNormalized),
    );
  }

  async upsertConversation(conversation: Conversation): Promise<ConversationRecord> {
    const existing = this.snapshot.conversations.find((record) => record.id === conversation.id);
    const record: ConversationRecord = {
      ...existing,
      ...conversation,
      messages: existing?.messages ?? [],
      events: existing?.events ?? [],
    };
    this.snapshot.conversations = [
      record,
      ...this.snapshot.conversations.filter((item) => item.id !== record.id),
    ];
    return structuredClone(record);
  }

  async addMessage(message: Message): Promise<Message> {
    const record = this.snapshot.conversations.find(
      (conversation) => conversation.id === message.conversationId,
    );
    if (!record) {
      throw new Error("Conversation not found");
    }
    record.messages.push(message);
    record.updatedAt = message.createdAt;
    record.lastMessagePreview = message.body.slice(0, 180);
    if (message.direction === "inbound") {
      record.unreadCount += 1;
      record.lastInboundAt = message.createdAt;
    } else {
      record.lastOutboundAt = message.createdAt;
    }
    return structuredClone(message);
  }

  async addEvent(event: ConversationEvent): Promise<ConversationEvent> {
    const record = this.snapshot.conversations.find(
      (conversation) => conversation.id === event.conversationId,
    );
    if (!record) {
      throw new Error("Conversation not found");
    }
    record.events.push(event);
    record.updatedAt = event.createdAt;
    return structuredClone(event);
  }

  async replaceConversation(record: ConversationRecord): Promise<ConversationRecord> {
    this.snapshot.conversations = [
      structuredClone(record),
      ...this.snapshot.conversations.filter((item) => item.id !== record.id),
    ];
    return structuredClone(record);
  }

  async seed(records: ConversationRecord[]): Promise<ConversationSnapshot> {
    this.snapshot = {
      conversations: structuredClone(records),
      updatedAt: new Date().toISOString(),
    };
    return this.load();
  }
}

type SmokeRow = {
  label: string;
  status: "OK" | "FAIL";
  expected: string;
  reply: string;
  intent: string;
  policyAction: string;
  renderTemplateId: string;
  renderSource: string;
  clientIdentityStatus: string;
  activeFlow: string;
  pendingFields: string;
  petName: string;
  availabilityTimeApplied: string;
  entryTime: string;
  exitTime: string;
  approximateTime: string;
  precheckStatus: string;
  noRepeatGuard: string;
  containsInternalCopy: string;
  proposalState: string;
  termsState: string;
  availabilityFirstTriggered: string;
  availabilityPrecheckStatus: string;
  contractGate: string;
  failureReason: string;
};

const SANDBOX_TO = "whatsapp:+14155238886";

function knownDirectory() {
  return createStaticClientDirectory([
    {
      nombre: "Laura Cliente",
      telefonoMovil: "+34 612 345 678",
      telefonoNormalizado: "34612345678",
      email: "laura@example.test",
      mascotas: ["Kira"],
      mascotasCount: 1,
      mascotasMatchStatus: "exact",
      rowNumber: 2,
      sheetName: "CLIENTES",
    },
  ]);
}

function payloadValue(event: ConversationEvent | undefined, key: string): string | undefined {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object" || !(key in payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return value === undefined ? undefined : String(value);
}

function lastEvent(record: ConversationRecord, eventType: string): ConversationEvent | undefined {
  return record.events.findLast((event) => event.eventType === eventType);
}

function hasEvent(record: ConversationRecord, eventType: string): boolean {
  return record.events.some((event) => event.eventType === eventType);
}

function summarizeReply(value?: string): string {
  return (value ?? "(sin autorespuesta)").replace(/\s+/g, " ").slice(0, 150);
}

function rowFromResult(input: {
  label: string;
  expected: string;
  result: Awaited<ReturnType<typeof handleInboundWhatsApp>>;
  ok: boolean;
  failureReason?: string;
}): SmokeRow {
  const nlu = lastEvent(input.result.conversation, "nlu_classified");
  const policy = lastEvent(input.result.conversation, "policy_decision");
  const rendered = lastEvent(input.result.conversation, "copy_rendered");
  const proposal = input.result.conversation.pendingReservationProposal;
  const availability = input.result.conversation.availabilityInquiry;
  return {
    label: input.label,
    status: input.ok ? "OK" : "FAIL",
    expected: input.expected,
    reply: summarizeReply(input.result.botReply?.body),
    intent: payloadValue(nlu, "intent") ?? "(policy)",
    policyAction: payloadValue(policy, "action") ?? payloadValue(policy, "route") ?? "(n/a)",
    renderTemplateId: payloadValue(rendered, "renderTemplateId") ?? "(n/a)",
    renderSource: payloadValue(rendered, "renderSource") ?? "(n/a)",
    clientIdentityStatus: input.result.conversation.clientStatus ?? "unknown",
    activeFlow: input.result.conversation.activeFlow ?? "none",
    pendingFields: availability?.missingFields.join(",") ?? "",
    petName: availability?.petName ?? "",
    availabilityTimeApplied: hasEvent(input.result.conversation, "availability_time_slot_applied") ? "yes" : "no",
    entryTime: availability?.checkInTime ?? "",
    exitTime: availability?.checkOutTime ?? "",
    approximateTime: availability?.approximateTime ?? "",
    precheckStatus: availability?.availabilityStatus ?? "none",
    noRepeatGuard: hasEvent(input.result.conversation, "availability_no_repeat_guard_triggered") ? "yes" : "no",
    containsInternalCopy: input.result.botReply?.body.includes("flujo operativo") ? "yes" : "no",
    proposalState: proposal?.status ?? "none",
    termsState: proposal?.termsAccepted
      ? "accepted"
      : proposal?.contractAcceptanceRequestedAt
        ? "contract_requested"
        : "none",
    availabilityFirstTriggered: hasEvent(input.result.conversation, "availability_first_triggered") ? "yes" : "no",
    availabilityPrecheckStatus: availability?.availabilityStatus ?? "none",
    contractGate:
      payloadValue(lastEvent(input.result.conversation, "contract_gate_applied"), "reason") ??
      payloadValue(lastEvent(input.result.conversation, "contract_gate_skipped"), "reason") ??
      "none",
    failureReason: input.failureReason ?? "",
  };
}

function assertRows(rows: SmokeRow[]): void {
  const failed = rows.filter((row) => row.status !== "OK" || row.containsInternalCopy === "yes");
  console.table(rows);
  if (failed.length > 0) {
    throw new Error(`functional baseline smoke failed: ${failed.map((row) => row.label).join(", ")}`);
  }
}

async function main() {
  const rows: SmokeRow[] = [];

  const welcomeStore = new MemoryConversationStore();
  await handleInboundWhatsApp(
    { from: "whatsapp:+34612345678", to: SANDBOX_TO, body: "hola", messageSid: "SM_FB_HELLO_1" },
    welcomeStore,
    knownDirectory(),
  );
  await handleInboundWhatsApp(
    { from: "whatsapp:+34612345678", to: SANDBOX_TO, body: "reiniciar", messageSid: "SM_FB_RESET" },
    welcomeStore,
    knownDirectory(),
  );
  const welcome = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34612345678",
      to: SANDBOX_TO,
      body: "hola buenas tardes",
      messageSid: "SM_FB_HELLO_2",
    },
    welcomeStore,
    knownDirectory(),
  );
  rows.push(rowFromResult({
    label: "reset-known-welcome",
    expected: "reset preserves identity; next greeting uses welcome",
    result: welcome,
    ok:
      welcome.conversation.clientStatus === "known" &&
      (welcome.botReply?.body.includes("Laura, bienvenido/a a Somos Muy Perros") ?? false) &&
      !welcome.botReply?.body.includes("Vista previa"),
  }));

  const availabilityStore = new MemoryConversationStore();
  const availability = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34612345010",
      to: SANDBOX_TO,
      body: "quería reservar para este fin de semana, ¿es posible?",
      messageSid: "SM_FB_AVAILABILITY",
    },
    availabilityStore,
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "availability-first-weekend",
    expected: "availability-first asks only pet and does not start reservation form",
    result: availability,
    ok:
      availability.conversation.reservationFlow === undefined &&
      availability.conversation.activeFlow === "availabilityInquiry" &&
      availability.conversation.availabilityInquiry?.relativeDateRange === "este_fin_de_semana" &&
      (availability.botReply?.body.includes("Me falta solo el nombre de la mascota") ?? false) &&
      !(availability.botReply?.body.includes("Tenemos disponibilidad") ?? false),
  }));

  const availabilityContinuation = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34612345010",
      to: SANDBOX_TO,
      body: "PAPO",
      messageSid: "SM_FB_AVAILABILITY_PET_SLOT",
    },
    availabilityStore,
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "availability-continuation-pet-slot",
    expected: "standalone pet name continues availability-first and runs preliminary calendar precheck",
    result: availabilityContinuation,
    ok:
      availabilityContinuation.conversation.reservationFlow === undefined &&
      availabilityContinuation.conversation.availabilityInquiry?.petName === "PAPO" &&
      availabilityContinuation.conversation.availabilityInquiry?.missingFields.join(",") === "times" &&
      availabilityContinuation.conversation.availabilityInquiry?.availabilityStatus === "available_preliminary" &&
      (availabilityContinuation.botReply?.body.includes("En principio aparece disponibilidad") ?? false) &&
      (availabilityContinuation.botReply?.body.includes("confirmar horarios de entrada y salida") ?? false) &&
      !(availabilityContinuation.botReply?.body.includes("Perdona, no te he entendido") ?? false) &&
      !(availabilityContinuation.botReply?.body.includes("flujo operativo") ?? false),
  }));

  const availabilityTime = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34612345010",
      to: SANDBOX_TO,
      body: "a las 10",
      messageSid: "SM_FB_AVAILABILITY_TIME_SINGLE",
    },
    availabilityStore,
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "availability-time-single-clarification",
    expected: "single time is kept as approximate time and asks a specific target clarification",
    result: availabilityTime,
    ok:
      availabilityTime.conversation.activeFlow === "availabilityInquiry" &&
      availabilityTime.conversation.availabilityInquiry?.petName === "PAPO" &&
      availabilityTime.conversation.availabilityInquiry?.approximateTime === "10:00" &&
      availabilityTime.conversation.availabilityInquiry?.missingFields.join(",") === "timeTarget" &&
      (availabilityTime.botReply?.body.includes("¿Las 10 serían para la entrada y también para la salida?") ?? false) &&
      availabilityTime.botReply?.body !== availabilityContinuation.botReply?.body &&
      !(availabilityTime.botReply?.body.includes("Perdona, no te he entendido") ?? false) &&
      !(availabilityTime.botReply?.body.includes("flujo operativo") ?? false) &&
      hasEvent(availabilityTime.conversation, "availability_no_repeat_guard_triggered"),
  }));

  const petAvailability = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34612345011",
      to: SANDBOX_TO,
      body: "hay hueco este finde para PIPO?",
      messageSid: "SM_FB_AVAILABILITY_PET",
    },
    availabilityStore,
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "availability-first-with-pet",
    expected: "range + pet asks only missing times without fake availability",
    result: petAvailability,
    ok:
      petAvailability.conversation.reservationFlow === undefined &&
      petAvailability.conversation.availabilityInquiry?.petName === "PIPO" &&
      petAvailability.conversation.availabilityInquiry?.missingFields.join(",") === "times" &&
      petAvailability.conversation.availabilityInquiry?.availabilityStatus === "available_preliminary" &&
      (petAvailability.botReply?.body.includes("En principio aparece disponibilidad") ?? false) &&
      (petAvailability.botReply?.body.includes("confirmar horarios de entrada y salida") ?? false) &&
      !(petAvailability.botReply?.body.includes("Tenemos disponibilidad") ?? false),
  }));

  const templatePreview = buildStatelessTemplatePreviewResult("plantilla confirmación", {
    NODE_ENV: "test",
  } as NodeJS.ProcessEnv);
  rows.push({
    label: "template-preview-confirmation",
    status:
      templatePreview?.reply.includes("Vista previa de plantilla: confirmación") &&
      templatePreview.reply.includes("¡Tu reserva ha sido confirmada!")
        ? "OK"
        : "FAIL",
    expected: "preview command shows real confirmation template only as preview",
    reply: summarizeReply(templatePreview?.reply),
    intent: "template_preview",
    policyAction: "prerouter_preview",
    renderTemplateId: "confirmation",
    renderSource: "template_preview",
    clientIdentityStatus: "n/a",
    activeFlow: "none",
    proposalState: "none",
    termsState: "none",
    pendingFields: "",
    petName: "",
    availabilityTimeApplied: "no",
    entryTime: "",
    exitTime: "",
    approximateTime: "",
    precheckStatus: "none",
    noRepeatGuard: "no",
    containsInternalCopy: templatePreview?.reply.includes("flujo operativo") ? "yes" : "no",
    availabilityFirstTriggered: "no",
    availabilityPrecheckStatus: "none",
    contractGate: "none",
    failureReason: "",
  });

  const reservationStore = new MemoryConversationStore();
  const reservation = await handleInboundWhatsApp(
    {
      from: "whatsapp:+34612345678",
      to: SANDBOX_TO,
      body: "quiero reservar",
      messageSid: "SM_FB_RESERVATION",
    },
    reservationStore,
    knownDirectory(),
  );
  rows.push(rowFromResult({
    label: "known-client-reservation-start",
    expected: "known client skips client-kind question and uses safe known pet",
    result: reservation,
    ok:
      reservation.conversation.reservationFlow?.status === "collecting_dates" &&
      reservation.conversation.reservationFlow.petName === "Kira" &&
      !(reservation.botReply?.body.includes("¿Ya eres cliente") ?? false),
  }));

  const faqStore = new MemoryConversationStore();
  await handleInboundWhatsApp(
    { from: "whatsapp:+34612345012", to: SANDBOX_TO, body: "quiero reservar", messageSid: "SM_FB_FAQ_START" },
    faqStore,
    createStaticClientDirectory([]),
  );
  const faq = await handleInboundWhatsApp(
    { from: "whatsapp:+34612345012", to: SANDBOX_TO, body: "¿y el pago?", messageSid: "SM_FB_FAQ_PAYMENT" },
    faqStore,
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "faq-inside-reservation",
    expected: "FAQ answers and resumes active reservation state",
    result: faq,
    ok:
      (faq.botReply?.body.includes("El pago se hace a la llegada") ?? false) &&
      (faq.botReply?.body.includes("Seguimos con la reserva") ?? false) &&
      faq.conversation.reservationFlow?.status === "asking_client_kind",
  }));

  await setConversationMode(faq.conversation.id, "human", "qa", faqStore);
  const human = await handleInboundWhatsApp(
    { from: "whatsapp:+34612345012", to: SANDBOX_TO, body: "sigo esperando", messageSid: "SM_FB_HUMAN" },
    faqStore,
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "human-mode-silence",
    expected: "human mode suppresses autoresponse",
    result: human,
    ok: human.botReply === undefined && human.noReplyReason === "human_mode_auto_reply_suppressed",
  }));

  const normal = await handleInboundWhatsApp(
    { from: "whatsapp:+34612345013", to: SANDBOX_TO, body: "hola", messageSid: "SM_FB_TWIML" },
    new MemoryConversationStore(),
    createStaticClientDirectory([]),
  );
  rows.push(rowFromResult({
    label: "normal-inbound-non-empty-twiml",
    expected: "normal inbound returns TwiML Message",
    result: normal,
    ok: Boolean(normal.twiml?.includes("<Message>")) && !normal.allowEmptyTwiml,
  }));

  assertRows(rows);
  console.log("smoke:functional-baseline ok");
}

main().catch((error) => {
  console.error(`[fail] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

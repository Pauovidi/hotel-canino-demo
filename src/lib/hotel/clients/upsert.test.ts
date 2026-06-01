import { describe, expect, it } from "vitest";

import { createStaticClientDirectory } from "./service";
import {
  buildClientDirectoryRowFromReservation,
  upsertClientFromConfirmedReservation,
} from "./upsert";

const BASE_INPUT = {
  phoneE164: "+34600009991",
  phoneNormalized: "34600009991",
  reservationId: "resv_qa_client_upsert_1234567890",
  petName: "Kira QA",
  checkIn: "2026-12-29",
  checkOut: "2026-12-31",
  source: "whatsapp_reservation" as const,
  now: new Date("2026-05-28T10:00:00.000Z"),
};

describe("client upsert from confirmed reservation", () => {
  it("builds a CLIENTES row without NIF and with controlled pending name fallback", () => {
    const { row, clientName, pendingName } = buildClientDirectoryRowFromReservation(BASE_INPUT);

    expect(clientName).toBe("Contacto WhatsApp ****9991");
    expect(pendingName).toBe(true);
    expect(row).toEqual([
      "sí",
      "2026-05-28",
      "",
      "Contacto WhatsApp ****9991",
      "",
      "",
      "+34600009991",
      "34600009991",
      "",
      expect.stringContaining("Alta automatica por reserva WhatsApp"),
      "false",
      "whatsapp_reservation",
      "2026-05-28T10:00:00.000Z",
    ]);
    expect(row[4]).toBe("");
  });

  it("does not create CLIENTES for known contacts", async () => {
    const appended: string[][] = [];
    const result = await upsertClientFromConfirmedReservation(BASE_INPUT, {
      directory: createStaticClientDirectory([
        {
          nombre: "Cliente QA Existente",
          telefonoNormalizado: "34600009991",
          rowNumber: 4,
          sheetName: "CLIENTES_QA",
        },
      ]),
      appendClientRow: async (row) => {
        appended.push(row);
        return { sheetName: "CLIENTES_QA", rowNumber: 5 };
      },
    });

    expect(result).toMatchObject({
      kind: "existing",
      clientStatus: "known",
      rowNumber: 4,
      sheetName: "CLIENTES_QA",
    });
    expect(appended).toHaveLength(0);
  });

  it("creates CLIENTES only for unknown contacts after a confirmed reservation", async () => {
    const appended: string[][] = [];
    const result = await upsertClientFromConfirmedReservation(
      {
        ...BASE_INPUT,
        clientName: "SMP QA Responsable",
        email: "qa-conversacional@example.test",
      },
      {
        directory: createStaticClientDirectory([]),
        appendClientRow: async (row) => {
          appended.push(row);
          return { sheetName: "CLIENTES_QA", rowNumber: 10 };
        },
      },
    );

    expect(result).toMatchObject({
      kind: "created",
      clientStatus: "known",
      clientName: "SMP QA Responsable",
      rowNumber: 10,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0][3]).toBe("SMP QA Responsable");
    expect(appended[0][4]).toBe("");
    expect(appended[0][8]).toBe("qa-conversacional@example.test");
    expect(appended[0][11]).toBe("whatsapp_reservation");
  });

  it("does not block a confirmed new client because of a weak name-only match", async () => {
    const appended: string[][] = [];
    const result = await upsertClientFromConfirmedReservation(
      {
        ...BASE_INPUT,
        phoneE164: "+34600008882",
        phoneNormalized: "34600008882",
        clientName: "SMP QA Responsable",
      },
      {
        directory: createStaticClientDirectory([
          {
            nombre: "SMP QA Responsable",
            telefonoNormalizado: "34611112222",
            email: "otra-persona@example.test",
            rowNumber: 12,
            sheetName: "CLIENTES_QA",
          },
        ]),
        appendClientRow: async (row) => {
          appended.push(row);
          return { sheetName: "CLIENTES_QA", rowNumber: 13 };
        },
      },
    );

    expect(result).toMatchObject({
      kind: "created",
      clientStatus: "known",
      rowNumber: 13,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0][3]).toBe("SMP QA Responsable");
    expect(appended[0][7]).toBe("34600008882");
  });

  it("does not duplicate CLIENTES when email already identifies an existing client", async () => {
    const appended: string[][] = [];
    const result = await upsertClientFromConfirmedReservation(
      {
        ...BASE_INPUT,
        phoneE164: "+34600008883",
        phoneNormalized: "34600008883",
        email: "cliente-existente@example.test",
      },
      {
        directory: createStaticClientDirectory([
          {
            nombre: "Cliente QA Email",
            telefonoNormalizado: "34622223333",
            email: "cliente-existente@example.test",
            rowNumber: 7,
            sheetName: "CLIENTES_QA",
          },
        ]),
        appendClientRow: async (row) => {
          appended.push(row);
          return { sheetName: "CLIENTES_QA", rowNumber: 11 };
        },
      },
    );

    expect(result).toMatchObject({
      kind: "existing",
      clientStatus: "known",
      rowNumber: 7,
    });
    expect(appended).toHaveLength(0);
  });

  it("skips ambiguous and blocked contacts", async () => {
    const ambiguous = await upsertClientFromConfirmedReservation(BASE_INPUT, {
      directory: createStaticClientDirectory([
        { nombre: "Cliente QA A", telefonoNormalizado: "34600009991" },
        { nombre: "Cliente QA B", telefonoNormalizado: "34600009991" },
      ]),
      appendClientRow: async () => {
        throw new Error("should not append ambiguous");
      },
    });
    const blocked = await upsertClientFromConfirmedReservation(BASE_INPUT, {
      directory: createStaticClientDirectory([
        {
          nombre: "Cliente QA Bloqueado",
          telefonoNormalizado: "34600009991",
          bloqueadoNoReservar: true,
        },
      ]),
      appendClientRow: async () => {
        throw new Error("should not append blocked");
      },
    });

    expect(ambiguous.kind).toBe("skipped_ambiguous");
    expect(blocked.kind).toBe("skipped_blocked");
  });
});

import { describe, expect, it } from "vitest";

import {
  renderBathOfferTemplate,
  renderPositiveReviewRequestTemplate,
  renderPostStayFollowupTemplate,
  renderPrearrivalReminderTemplate,
  renderReservationConfirmationTemplate,
  renderReservationDeniedTemplate,
  renderReservationWelcomeIntroTemplate,
} from "./client-templates";

describe("SMP client templates", () => {
  it("renders the complete real reservation confirmation template", () => {
    const rendered = renderReservationConfirmationTemplate({
      clientName: "Pau",
      petNames: ["PIPO"],
      checkIn: "2026-12-25",
      checkOut: "2026-12-26",
      checkInTime: "10:00",
      checkOutTime: "10:00",
      price: 30,
    });

    expect(rendered).not.toContain("ATENCIÓN LEER HASTA EL FINAL");
    expect(rendered.startsWith("*Hola* Pau")).toBe(true);
    expect(rendered).toContain("*Hola* Pau");
    expect(rendered).toContain("Mascotas: PIPO");
    expect(rendered).toContain("El coste de la estancia es de *30€*");
    expect(rendered).toContain("El pago se realiza a la llegada y en efectivo.");
    expect(rendered).toContain("Avísanos cuando vengas de camino: 682 621 177");
    expect(rendered).toContain("https://goo.gl/maps/4M6YHVRhJTFeHPjq9");
    expect(rendered).not.toContain("Reserva confirmada. Cliente:");
  });

  it("requires a price for the real confirmation template", () => {
    expect(() =>
      renderReservationConfirmationTemplate({
        clientName: "Pau",
        petNames: ["PIPO"],
        checkIn: "2026-12-25",
        checkOut: "2026-12-26",
      }),
    ).toThrow("reservation_confirmation_price_required");
  });

  it("renders bath offer copy without sending it automatically", () => {
    expect(renderBathOfferTemplate({ petNames: ["PIPO"] })).toContain(
      "¿Quieres que bañemos a PIPO antes de la salida?",
    );
    expect(renderBathOfferTemplate()).toContain("15€ para perros pequeños");
    expect(renderBathOfferTemplate()).toContain("20 para perros medianos");
    expect(renderBathOfferTemplate()).toContain("25 para perros grandes");
    expect(renderBathOfferTemplate()).toContain(
      "para pelo largo , nudos o corte de razas especificas preguntar adjuntado una foto",
    );
  });

  it("renders the reservation welcome intro", () => {
    expect(
      renderReservationWelcomeIntroTemplate({
        clientName: "Laura",
        petNames: ["Kira"],
      }),
    ).toContain("Soy Maria Jose, del Hotel Canino SomosMuyPerros.");
  });

  it("renders the safe denied reservation template without inventing waitlist support", () => {
    const rendered = renderReservationDeniedTemplate({
      clientName: "Pau",
      petNames: ["PIPO"],
      waitlistSupported: false,
    });

    expect(rendered).toContain("no tenemos disponibilidad");
    expect(rendered).toContain("podemos dejarlo anotado para que el equipo lo revise");
    expect(rendered).not.toContain("la hemos anotado en nuestra lista de espera");
  });

  it("renders prearrival reminder copy", () => {
    expect(
      renderPrearrivalReminderTemplate({
        clientName: "Pau",
        petNames: ["PIPO"],
        entryText: "25 de diciembre de 2026 a las 10:00",
      }),
    ).toContain("Le recordamos que tiene una reserva en nuestro Hotel Canino.");
  });

  it("renders post-stay and positive review templates", () => {
    expect(
      renderPostStayFollowupTemplate({
        clientName: "Pau",
        petNames: ["PIPO"],
      }),
    ).toContain("después de su estancia con nosotros");
    expect(renderPositiveReviewRequestTemplate()).toContain(
      "https://g.page/r/CbNKrJ36PLSeEBE/review",
    );
  });
});

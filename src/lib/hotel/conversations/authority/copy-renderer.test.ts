import { describe, expect, it } from "vitest";

import { renderCopy } from "./copy-renderer";

describe("conversation CopyRenderer", () => {
  it("maps real client template render keys", () => {
    const confirmation = renderCopy({
      key: "reservation_confirmation",
      name: "Pau",
      pets: ["PIPO"],
      checkIn: "2026-12-25",
      checkOut: "2026-12-26",
      checkInTime: "10:00",
      checkOutTime: "10:00",
      price: 30,
    });
    const denial = renderCopy({
      key: "reservation_denial",
      name: "Pau",
      pets: ["PIPO"],
    });
    const bath = renderCopy({ key: "bath_offer", pets: ["PIPO"] });
    const reminder = renderCopy({
      key: "reservation_reminder",
      name: "Pau",
      pets: ["PIPO"],
      entryText: "25 de diciembre de 2026 a las 10:00",
    });
    const review = renderCopy({ key: "positive_review_request" });

    expect(confirmation).toContain("¡Tu reserva ha sido confirmada! ✅");
    expect(confirmation).toContain("El coste de la estancia es de *30€*");
    expect(confirmation).toContain("Horario de recepción: *8:00–11:00 | 16:30–19:30*");
    expect(confirmation).toContain("📞 Avísanos cuando vengas de camino: 682 621 177");
    expect(confirmation).toContain("https://goo.gl/maps/4M6YHVRhJTFeHPjq9");
    expect(denial).toContain("Soy Rocío del Hotel Canino SomosMuyPerros");
    expect(bath).toContain("¿Quieres que bañemos a PIPO");
    expect(bath).toContain("15€ para perros pequeños");
    expect(bath).toContain("20 para perros medianos");
    expect(bath).toContain("25 para perros grandes");
    expect(bath).toContain("para pelo largo , nudos o corte de razas especificas preguntar adjuntado una foto");
    expect(reminder).toContain("Le recordamos que tiene una reserva");
    expect(review).toContain("https://g.page/r/CbNKrJ36PLSeEBE/review");
  });

  it("renders quality presales replies without generic handoff", () => {
    const general = renderCopy({
      key: "conversation.general_hotel_info",
      message: "Buenos días, me gustaría saber más sobre el hotel",
    });
    const mixed = renderCopy({
      key: "conversation.mixed_reservation_info_intro",
      message: "Quiero reservar pero antes saber algunas cosas",
    });

    expect(general).toContain("Somos Muy Perros");
    expect(general).not.toContain("Gracias, revisamos");
    expect(mixed).toContain("después seguimos con la reserva");
    expect(mixed).not.toContain("Perfecto, te paso");
  });

  it("renders welcome keys without preview or preconfirmation copy", () => {
    const known = renderCopy({
      key: "conversation.welcome_known_client",
      message: "hola buenas tardes",
      firstName: "Laura",
    });
    const unknown = renderCopy({
      key: "conversation.welcome_unknown_client",
      message: "hola",
    });

    expect(known).toContain("Laura, bienvenido/a a Somos Muy Perros");
    expect(known).toContain("reservas, disponibilidad, precios, cambios o dudas");
    expect(known).not.toContain("Vista previa");
    expect(known).not.toContain("Soy Maria Jose");
    expect(unknown).toContain("bienvenido/a a Somos Muy Perros");
    expect(unknown).not.toContain("A continuación te detallo la confirmación");
  });

  it("renders availability-first keys without fake availability", () => {
    const collectPet = renderCopy({
      key: "availability_first_collect_pet",
      message: "quería reservar para este fin de semana, ¿es posible?",
      relativeDateRange: "este fin de semana",
    });
    const clarifyRange = renderCopy({ key: "availability_first_clarify_range" });
    const needsDetails = renderCopy({ key: "availability_first_needs_details" });
    const contextual = renderCopy({ key: "availability_first_handoff_contextual" });
    const offer = renderCopy({ key: "availability_first_offer_reservation" });

    expect(collectPet).toContain("Me falta solo el nombre de la mascota");
    expect(collectPet).toContain("No te confirmo plaza");
    expect(collectPet).not.toContain("Tenemos disponibilidad");
    expect(collectPet).not.toContain("fecha de entrada, la fecha de salida y el nombre");
    expect(clarifyRange).toContain("Me falta la fecha o rango aproximado");
    expect(needsDetails).toContain("Me faltan el nombre de la mascota");
    expect(contextual).toContain("disponibilidad real");
    expect(offer).toContain("seguimos con la reserva");
  });
});

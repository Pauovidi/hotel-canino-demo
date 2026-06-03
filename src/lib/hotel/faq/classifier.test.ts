import { describe, expect, it } from "vitest";
import { classifyFaqIntent } from "./classifier";
import { matchFaqIntent } from "@/lib/hotel/knowledge/faq";

describe("FAQ intent classification", () => {
  it("clasifica peticiones operativas y FAQ base", () => {
    expect(classifyFaqIntent("quiero reservar").intent).toBe("workflow_reserva");
    expect(classifyFaqIntent("¿cómo hago una reserva?").intent).toBe(
      "faq_reserva_formulario",
    );
    expect(classifyFaqIntent("¿me confirmáis por whatsapp?").intent).toBe(
      "faq_confirmacion_whatsapp",
    );
    expect(classifyFaqIntent("¿puedo recogerlo a las 20:00?").intent).toBe(
      "faq_fuera_de_horario",
    );
    expect(classifyFaqIntent("¿puedo recoger a mi perro a las 15h?").intent).toBe(
      "faq_fuera_de_horario",
    );
    expect(classifyFaqIntent("¿cuánto cuesta 2 perros?").intent).toBe(
      "faq_precio_hotel",
    );
    expect(classifyFaqIntent("¿qué vacunas pedís?").intent).toBe(
      "faq_vacunas",
    );
    expect(
      classifyFaqIntent("¿es recomendable dejar a mi perro en una residencia?")
        .intent,
    ).toBe("faq_confianza_residencia");
    expect(classifyFaqIntent("¿la comida está incluida?").intent).toBe(
      "faq_comida",
    );
    expect(classifyFaqIntent("¿mandáis fotos?").intent).toBe("faq_fotos");
    expect(classifyFaqIntent("¿tenéis peluquería?").intent).toBe(
      "faq_peluqueria",
    );
    expect(classifyFaqIntent("¿y el pago?").intent).toBe("faq_pago_senal");
    expect(classifyFaqIntent("¿puedo pagar por bizum?").intent).toBe("faq_pago_senal");
    expect(classifyFaqIntent("¿cuándo se paga?").intent).toBe("faq_pago_senal");
    expect(classifyFaqIntent("quiero cambiar la reserva").intent).toBe(
      "faq_cancelacion",
    );
    expect(classifyFaqIntent("¿tenéis sitio del 14 al 18 de abril?").intent).toBe(
      "workflow_disponibilidad",
    );
    expect(classifyFaqIntent("quiero visitar el hotel").intent).toBe(
      "faq_visitas_hotel",
    );
    expect(classifyFaqIntent("¿qué tengo que llevar?").intent).toBe(
      "faq_que_llevar",
    );
    expect(classifyFaqIntent("lo recoge mi padre").intent).toBe(
      "faq_recogida_familiar",
    );
    expect(classifyFaqIntent("¿me recomendáis otro sitio?").intent).toBe(
      "faq_recomendacion_otro_sitio",
    );
    expect(classifyFaqIntent("¿pasan frío o calor?").intent).toBe(
      "faq_climatizacion",
    );
    expect(classifyFaqIntent("¿cuánto tiempo salen al aire libre?").intent).toBe(
      "faq_tiempo_aire_libre",
    );
    expect(classifyFaqIntent("¿ha comido?").intent).toBe(
      "faq_seguimiento_estancia",
    );
    expect(
      classifyFaqIntent("mi perro es muy especial te puedo llamar y contarte")
        .intent,
    ).toBe("handoff_humano");
  });

  it.each([
    "hola",
    "hola!",
    "buenos días",
    "hola buenos días",
    "buenas tardes",
    "hola buenas tardes",
    "buenas noches",
    "hola buenas noches",
    "hola, qué tal",
  ])("does not match pure greeting %s as a shared FAQ", (message) => {
    expect(matchFaqIntent(message)).toBeUndefined();
  });

  it.each([
    "¿cuál es el horario?",
    "¿a qué hora puedo dejar al perro?",
    "¿puedo recogerlo por la tarde?",
    "horario de recepción",
  ])("keeps explicit reception schedule question %s as horario FAQ", (message) => {
    expect(matchFaqIntent(message)?.intent).toBe("faq_horario");
  });

  it("marca la salida esperada por tipo de consulta", () => {
    expect(classifyFaqIntent("quiero reservar").outputType).toBe("workflow");
    expect(classifyFaqIntent("¿qué vacunas pedís?").outputType).toBe("faq");
    expect(
      classifyFaqIntent("¿mi perro estará bien en una residencia?").outputType,
    ).toBe("faq");
    expect(classifyFaqIntent("¿tenéis peluquería?").outputType).toBe("faq");
  });

  it("cubre variantes de confianza y seguridad como FAQ", () => {
    const samples = [
      "¿es recomendable dejar a mi perro en una residencia?",
      "¿es bueno dejarlo en una residencia canina?",
      "¿es seguro dejar a mi perro ahí?",
      "¿mi perro estará bien en una residencia?",
      "me da miedo dejar a mi perro en una residencia",
      "¿cómo sé si una residencia canina es buena?",
    ];

    for (const sample of samples) {
      const result = classifyFaqIntent(sample);

      expect(result.intent).toBe("faq_confianza_residencia");
      expect(result.outputType).toBe("faq");
      expect(result.usedFallback).toBe(false);
    }
  });

  it("mueve preguntas cercanas de comportamiento no grave a FAQ en vez de humano", () => {
    const result = classifyFaqIntent(
      "mi perro es miedoso, ¿estará bien en una residencia?",
    );

    expect(result.intent).toBe("faq_comportamiento");
    expect(result.outputType).toBe("faq");
  });

  it("solo deriva a humano cuando aparecen matices especiales", () => {
    expect(
      classifyFaqIntent("mi perro es agresivo, ¿estará bien en residencia?")
        .intent,
    ).toBe("handoff_humano");
    expect(
      classifyFaqIntent(
        "¿es seguro dejar a mi perro ahí si necesita insulina?",
      ).intent,
    ).toBe("handoff_humano");
    expect(
      classifyFaqIntent(
        "me da miedo dejarlo porque tiene ansiedad por separación muy fuerte",
      ).intent,
    ).toBe("handoff_humano");
    expect(
      classifyFaqIntent(
        "¿es recomendable dejarlo si es un caso veterinario delicado?",
      ).intent,
    ).toBe("handoff_humano");
  });

  it("cae a humano cuando la consulta no encaja en el catálogo", () => {
    const result = classifyFaqIntent("te cuento una cosa rara de mi perro");

    expect(result.intent).toBe("handoff_humano");
    expect(result.usedFallback).toBe(true);
  });
});

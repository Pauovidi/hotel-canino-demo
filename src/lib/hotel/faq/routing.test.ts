import { describe, expect, it } from "vitest";
import { FAQ_ROUTING_RULES } from "./catalog";
import { resolveFaqQuery } from "./router";

describe("FAQ routing", () => {
  it("mantiene el mapa de routing documentado", () => {
    expect(FAQ_ROUTING_RULES).toHaveLength(4);
    expect(
      FAQ_ROUTING_RULES.some((rule) =>
        rule.intents.includes("workflow_disponibilidad"),
      ),
    ).toBe(true);
    expect(
      FAQ_ROUTING_RULES.some((rule) =>
        rule.intents.includes("faq_confianza_residencia"),
      ),
    ).toBe(true);
    expect(
      FAQ_ROUTING_RULES.some((rule) =>
        rule.intents.includes("handoff_humano"),
      ),
    ).toBe(true);
  });

  it("deriva reserva por chat al formulario sin improvisar", () => {
    const result = resolveFaqQuery("quiero reservar");

    expect(result.intent).toBe("workflow_reserva");
    expect(result.outputType).toBe("workflow");
    expect(result.reply).toContain("formulario");
    expect(result.actions[0]?.url).toBe("https://somosmuyperros.com/hotel-canino/");
  });

  it("mantiene FAQ pura para preguntas informativas", () => {
    const result = resolveFaqQuery("¿me confirmáis por whatsapp?");

    expect(result.intent).toBe("faq_confirmacion_whatsapp");
    expect(result.outputType).toBe("faq");
    expect(result.reply).toContain("WhatsApp");
  });

  it("responde confianza en la residencia como FAQ con CTA útiles", () => {
    const result = resolveFaqQuery(
      "¿es recomendable dejar a mi perro en una residencia?",
    );

    expect(result.intent).toBe("faq_confianza_residencia");
    expect(result.outputType).toBe("faq");
    expect(result.reply).toContain("buena opción");
    expect(result.actions.map((action) => action.label)).toEqual([
      "Cómo funciona el alojamiento",
      "Ir al formulario de reserva",
    ]);
  });

  it("pasa a workflow la disponibilidad concreta", () => {
    const result = resolveFaqQuery("¿tenéis sitio del 14 al 18 de abril?");

    expect(result.intent).toBe("workflow_disponibilidad");
    expect(result.outputType).toBe("workflow");
    expect(result.actions.some((action) => action.label.includes("formulario"))).toBe(true);
  });

  it("responde servicios como FAQ y deriva a humano solo casos especiales", () => {
    const peluqueria = resolveFaqQuery("¿tenéis peluquería?");
    const especial = resolveFaqQuery(
      "mi perro es muy especial te puedo llamar y contarte",
    );

    expect(peluqueria.intent).toBe("faq_peluqueria");
    expect(peluqueria.outputType).toBe("faq");
    expect(peluqueria.reply).toContain("servicios complementarios");
    expect(especial.intent).toBe("handoff_humano");
    expect(especial.outputType).toBe("handoff");
  });

  it("solo deriva a humano los matices especiales de confianza", () => {
    const agresividad = resolveFaqQuery(
      "mi perro es agresivo, ¿estará bien en residencia?",
    );
    const medicacionCompleja = resolveFaqQuery(
      "¿es seguro dejar a mi perro ahí si necesita insulina?",
    );
    const ansiedadSevera = resolveFaqQuery(
      "me da miedo dejarlo porque tiene ansiedad por separación muy fuerte",
    );

    expect(agresividad.outputType).toBe("handoff");
    expect(medicacionCompleja.outputType).toBe("handoff");
    expect(ansiedadSevera.outputType).toBe("handoff");
  });

  it("personaliza la respuesta de precio hotel por número de perros", () => {
    const result = resolveFaqQuery("¿cuánto cuesta 2 perros?");

    expect(result.intent).toBe("faq_precio_hotel");
    expect(result.reply).toContain("45 €");
  });
});

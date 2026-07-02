import { HOTEL_DEMO_CONFIG } from "../config";
import type {
  FaqCategoryDefinition,
  FaqCategoryId,
  FaqDemoPrompt,
  FaqIntentId,
  FaqIntentMatch,
  FaqKnowledgeEntry,
  FaqKnowledgePack,
  FaqWidgetRoute,
} from "./types";
import { normalizeFaqText } from "./text";

const FAQ_CATEGORY_BASE_DEFINITIONS = [
  {
    id: "reservas_confirmacion",
    title: "Reservas y confirmación",
    summary: "Formulario, confirmación por WhatsApp y siguientes pasos.",
  },
  {
    id: "horarios_entregas",
    title: "Horarios y entregas",
    summary: "Franja de recepción para dejar y recoger perros.",
  },
  {
    id: "precios_hotel",
    title: "Precios hotel",
    summary: "Tarifas publicadas del hotel canino y suplemento de medio día.",
  },
  {
    id: "precios_guarderia",
    title: "Precios guardería",
    summary: "Precio diario y bono de 10 días de la guardería canina.",
  },
  {
    id: "requisitos_sanitarios",
    title: "Requisitos sanitarios y vacunas",
    summary: "Vacunas, cartilla, microchip y antiparasitarios obligatorios.",
  },
  {
    id: "confianza_seguridad_residencia",
    title: "Confianza y seguridad",
    summary: "Dudas sobre si la residencia es una buena opción y cómo cuidamos la estancia.",
  },
  {
    id: "medicacion_comportamiento",
    title: "Medicación y comportamiento",
    summary: "Pautas médicas, carácter y convivencia con otros perros.",
  },
  {
    id: "comida_fotos_servicios",
    title: "Comida, fotos y servicios",
    summary: "Alimentación incluida, vídeos y cuidados básicos durante la estancia.",
  },
  {
    id: "peluqueria",
    title: "Peluquería",
    summary: "Servicio complementario con reserva previa y revisión humana.",
  },
  {
    id: "pagos_senal",
    title: "Pagos y señal",
    summary: "Forma de pago publicada y tratamiento conservador de dudas no confirmadas.",
  },
  {
    id: "cancelaciones",
    title: "Cancelaciones",
    summary: "Cambios o cancelaciones con revisión manual cuando la política no está detallada.",
  },
  {
    id: "ubicacion_contacto",
    title: "Ubicación y contacto",
    summary: "Dirección, teléfono y email del centro.",
  },
  {
    id: "visitas_recogidas",
    title: "Visitas y recogidas",
    summary: "Visitas al hotel y recogidas por familiares o amigos.",
  },
  {
    id: "bienestar_estancia",
    title: "Bienestar durante la estancia",
    summary: "Climatización, tiempo al aire libre y seguimiento seguro.",
  },
  {
    id: "especiales_humano",
    title: "Preguntas especiales",
    summary: "Casos delicados o complejos que deben pasar al equipo humano.",
  },
] as const;

export const FAQ_KNOWLEDGE_ENTRIES: readonly FaqKnowledgeEntry[] = [
  {
    intent: "faq_reserva_formulario",
    category: "reservas_confirmacion",
    outputType: "faq",
    label: "Reserva por formulario",
    question: "¿Cómo hago una reserva?",
    answer:
      "La reserva se hace desde el formulario web. Cuando nos llega, revisamos disponibilidad y te contestamos con la confirmación y el precio.",
    examples: [
      "¿cómo hago una reserva?",
      "¿cómo reservo?",
      "¿dónde se hace la reserva?",
      "quiero saber cómo reservar",
    ],
    synonyms: [
      "reserva online",
      "formulario",
      "proceso de reserva",
      "reserva web",
      "quiero reservar por la web",
      "cerrar reserva",
    ],
    actionPresets: ["booking_form"],
  },
  {
    intent: "faq_confirmacion_whatsapp",
    category: "reservas_confirmacion",
    outputType: "faq",
    label: "Confirmación por WhatsApp",
    question: "¿Me confirmáis por WhatsApp?",
    answer:
      "Sí. Tras enviar el formulario revisamos la solicitud y te confirmamos por WhatsApp la disponibilidad, el precio y el siguiente paso.",
    examples: [
      "¿me confirmáis por whatsapp?",
      "¿me contestáis por whatsapp?",
      "¿la confirmación llega por whatsapp?",
    ],
    synonyms: [
      "confirmacion por whatsapp",
      "confirmar por chat",
      "respuesta por whatsapp",
      "aviso por whatsapp",
    ],
    actionPresets: ["booking_form"],
  },
  {
    intent: "faq_horario",
    category: "horarios_entregas",
    outputType: "faq",
    label: "Horario de recepción",
    question: "¿Cuál es el horario?",
    answer:
      "El horario de recepción es de 8:00 a 11:00 y de 16:30 a 19:30. Para la reserva indicamos hora de entrada y salida para organizar la estancia.",
    examples: [
      "¿qué horario tenéis?",
      "¿a qué hora puedo dejarlo?",
      "¿cuál es el horario de recepción?",
    ],
    synonyms: [
      "horario",
      "recepcion",
      "recepción",
      "hora de entrada",
      "hora de recogida",
      "dejar perro",
      "recoger",
      "cuando puedo dejar",
      "a que hora puedo llevarlo",
    ],
  },
  {
    intent: "faq_fuera_de_horario",
    category: "horarios_entregas",
    outputType: "faq",
    label: "Fuera de horario",
    question: "¿Puedo recogerlo fuera de horario?",
    answer:
      "No, fuera del horario de recepción no es posible dejar ni recoger perros. El horario correcto es de 08:00 a 11:00 y de 16:30 a 19:30.",
    examples: [
      "¿puedo recogerlo a las 20:00?",
      "¿puedo dejarlo antes de las 8?",
      "¿se puede recoger fuera de horario?",
    ],
    synonyms: [
      "fuera de horario",
      "llego tarde",
      "recogerlo a las 20",
      "antes de las 8",
      "despues de las 19:30",
      "después de las 19:30",
    ],
  },
  {
    intent: "faq_precio_hotel",
    category: "precios_hotel",
    outputType: "faq",
    label: "Precio hotel",
    question: "¿Cuánto cuesta el hotel canino?",
    answer:
      "Las tarifas 2026 son: 1 perro 30 €/noche, 2 perros 45 €/noche, 3 perros 50 €/noche y 4 perros 55 €/noche. Si me indicas fechas y mascotas, puedo calcular el precio de la estancia.",
    examples: [
      "¿cuánto cuesta 2 perros?",
      "¿cuánto vale el hotel?",
      "precio del hotel canino",
      "tarifa para tres perros",
    ],
    synonyms: [
      "precio hotel",
      "cuanto vale",
      "cuanto cuesta",
      "tarifa por noche",
      "noche hotel canino",
      "precio 1 perro",
      "precio 2 perros",
      "precio 3 perros",
      "precio 4 perros",
    ],
  },
  {
    intent: "faq_precio_guarderia",
    category: "precios_guarderia",
    outputType: "faq",
    label: "Precio guardería",
    question: "¿Cuánto cuesta la guardería?",
    answer:
      "La tarifa publicada para 2026 de guardería canina es de 25 € por día.",
    examples: [
      "¿cuánto cuesta la guardería?",
      "precio guardería",
      "¿cuánto vale dejarlo unas horas?",
    ],
    synonyms: [
      "guarderia",
      "guardería",
      "precio por dia",
      "precio por día",
      "dejarlo unas horas",
      "guarderia de dia",
      "guardería de día",
    ],
  },
  {
    intent: "faq_bono_guarderia",
    category: "precios_guarderia",
    outputType: "faq",
    label: "Bono guardería",
    question: "¿Tenéis bono de guardería?",
    answer:
      "Sí. La tarifa publicada para 2026 del bono de 10 días de guardería es de 220 €.",
    examples: [
      "¿tenéis bono de guardería?",
      "precio del bono de 10 días",
      "¿cuánto vale el bono?",
    ],
    synonyms: [
      "bono guarderia",
      "bono guardería",
      "10 dias",
      "10 días",
      "bono de diez dias",
      "bono mensual",
    ],
  },
  {
    intent: "faq_vacunas",
    category: "requisitos_sanitarios",
    outputType: "faq",
    label: "Vacunas y requisitos",
    question: "¿Qué vacunas pedís?",
    answer:
      "Para los requisitos de alojamiento, vacunas y documentación, lo revisa el equipo antes de la estancia. Si tienes dudas concretas, un miembro del equipo te lo aclarará.",
    examples: [
      "¿qué vacunas pedís?",
      "¿qué necesita para entrar?",
      "¿hace falta microchip y cartilla?",
    ],
    synonyms: [
      "vacunas",
      "rabia",
      "polivalente",
      "tos de las perreras",
      "tos perrera",
      "microchip",
      "cartilla",
      "documentacion",
      "documentación",
      "requisitos",
      "contrato",
      "admision",
      "admisión",
      "pasaporte",
      "desparasitacion",
      "desparasitación",
    ],
  },
  {
    intent: "faq_confianza_residencia",
    category: "confianza_seguridad_residencia",
    outputType: "faq",
    label: "Confianza en la residencia",
    question: "¿Es recomendable dejar a mi perro en una residencia?",
    answer:
      "Sí, puede ser una buena opción siempre que la residencia esté bien gestionada y se adapte a las necesidades del perro. En nuestro caso, trabajamos con requisitos previos, revisión de la estancia y seguimiento para que el alojamiento sea seguro y tranquilo. Si quieres, te explico cómo funciona el alojamiento o puedes ir directamente al formulario de reserva.",
    examples: [
      "¿es recomendable dejar a mi perro en una residencia?",
      "¿es bueno dejarlo en una residencia canina?",
      "¿es seguro dejar a mi perro ahí?",
      "¿mi perro estará bien en una residencia?",
      "me da miedo dejar a mi perro en una residencia",
      "¿cómo sé si una residencia canina es buena?",
    ],
    synonyms: [
      "confianza residencia canina",
      "seguridad residencia canina",
      "es buena idea dejarlo en una residencia",
      "puedo confiar en una residencia canina",
      "mi perro estará bien alojado",
      "residencia canina de confianza",
      "alojamiento seguro para perros",
    ],
    actionPresets: ["lodging_info", "booking_form"],
  },
  {
    intent: "faq_medicacion",
    category: "medicacion_comportamiento",
    outputType: "faq",
    label: "Medicación",
    question: "¿Podéis darle medicación?",
    answer:
      "Sí. Necesitamos que la posología quede por escrito y que traigas la medicación y los instrumentos necesarios. Ok, lo anotamos todo en su ficha para que no se nos pase ni un detalle.",
    examples: [
      "¿podéis darle medicación?",
      "mi perro toma pastillas",
      "tiene tratamiento y os lo tendría que explicar",
    ],
    synonyms: [
      "medicacion",
      "medicación",
      "tratamiento",
      "pastillas",
      "pauta",
      "insulina",
      "medicina",
    ],
    actionPresets: ["whatsapp_contact"],
  },
  {
    intent: "faq_comportamiento",
    category: "medicacion_comportamiento",
    outputType: "faq",
    label: "Comportamiento",
    question: "¿Importa cómo es mi perro?",
    answer:
      "Ok, lo anotamos todo en su ficha para que no se nos pase ni un detalle. Es importante que nos indiques su carácter, convivencia con otros perros, dolencias y cualquier detalle relevante.",
    examples: [
      "mi perro no se lleva bien con todos",
      "¿os tengo que contar cómo es?",
      "¿importa el comportamiento?",
    ],
    synonyms: [
      "caracter",
      "carácter",
      "comportamiento",
      "sociable",
      "reactivo",
      "agresivo",
      "especial",
    ],
    actionPresets: ["whatsapp_contact"],
  },
  {
    intent: "faq_comida",
    category: "comida_fotos_servicios",
    outputType: "faq",
    label: "Comida",
    question: "¿La comida está incluida?",
    answer:
      "Tenemos en cuenta las particularidades de alimentación de cada perro. Si necesita comida propia, alimentación especial o medicación, indícalo en la reserva para que el equipo lo revise.",
    examples: [
      "¿la comida está incluida?",
      "¿tengo que llevar su pienso?",
      "¿podéis darle su comida habitual?",
    ],
    synonyms: [
      "comida",
      "pienso",
      "alimentacion",
      "alimentación",
      "barf",
      "medicacion",
      "medicación",
      "puede llevar su comida",
      "comida incluida",
    ],
  },
  {
    intent: "faq_fotos",
    category: "comida_fotos_servicios",
    outputType: "faq",
    label: "Fotos y vídeos",
    question: "¿Mandáis fotos o vídeos?",
    answer:
      "Durante la estancia se pueden enviar vídeos o información para que sepas cómo está tu perro.",
    examples: [
      "¿mandáis fotos?",
      "¿enviáis vídeos?",
      "¿me vais contando cómo está?",
    ],
    synonyms: [
      "fotos",
      "videos",
      "vídeos",
      "video",
      "vídeo",
      "mandais",
      "mandáis",
      "como se como esta",
      "cómo sé cómo está",
      "informacion durante estancia",
      "información durante estancia",
      "informacion diaria",
      "información diaria",
    ],
  },
  {
    intent: "faq_peluqueria",
    category: "peluqueria",
    outputType: "faq",
    label: "Peluquería",
    question: "¿Tenéis peluquería?",
    answer:
      "El hotel cuenta con servicios complementarios como alimentación premium/BARF, asistencia veterinaria, peluquería previa contratación y adiestramiento. Si solo necesitas dejarlo unas horas, también existe la opción de guardería canina.",
    examples: [
      "¿tenéis peluquería?",
      "¿podéis bañarlo antes de salir?",
      "quiero peluquería para mi perro",
    ],
    synonyms: [
      "peluqueria",
      "peluquería",
      "baño",
      "bano",
      "corte",
      "grooming",
      "servicios",
      "adiestramiento",
      "guarderia",
      "guardería",
    ],
    actionPresets: ["whatsapp_contact", "contact_page"],
  },
  {
    intent: "faq_veterinario",
    category: "comida_fotos_servicios",
    outputType: "faq",
    label: "Atención veterinaria",
    question: "¿Tenéis veterinario?",
    answer:
      "El hotel cuenta con servicios complementarios como alimentación premium/BARF, asistencia veterinaria, peluquería previa contratación y adiestramiento. Si solo necesitas dejarlo unas horas, también existe la opción de guardería canina.",
    examples: [
      "¿tenéis veterinario?",
      "¿qué pasa si tiene una urgencia?",
      "¿hay asistencia veterinaria?",
    ],
    synonyms: [
      "veterinario",
      "veterinaria",
      "urgencia",
      "emergencia",
      "24 horas",
      "asistencia veterinaria",
    ],
  },
  {
    intent: "faq_pago_senal",
    category: "pagos_senal",
    outputType: "faq",
    label: "Pagos y señal",
    question: "¿Cómo se paga? ¿Hay señal?",
    answer:
      "El pago se hace a la llegada. Se puede pagar en efectivo, Bizum o transferencia. La señal no es obligatoria, aunque si se paga por transferencia el justificante debe enviarse antes cuando corresponda.",
    examples: [
      "¿cómo se paga?",
      "¿cuándo se paga?",
      "¿hay que dejar señal?",
      "¿aceptáis tarjeta o bizum?",
    ],
    synonyms: [
      "pago",
      "pagar",
      "senal",
      "señal",
      "efectivo",
      "bizum",
      "tarjeta",
      "transferencia",
      "anticipo",
      "fianza",
      "cuando se paga",
      "cuándo se paga",
    ],
    actionPresets: ["whatsapp_contact"],
  },
  {
    intent: "faq_cancelacion",
    category: "cancelaciones",
    outputType: "faq",
    label: "Cancelaciones",
    question: "¿Qué pasa si cancelo?",
    answer:
      "Podemos revisar cambios o cancelaciones de reserva. Dime qué necesitas cambiar y el equipo revisará disponibilidad o condiciones.",
    examples: [
      "¿qué pasa si cancelo?",
      "¿puedo cambiar fechas?",
      "¿cómo funcionan las cancelaciones?",
    ],
    synonyms: [
      "cancelacion",
      "cancelación",
      "cancelar",
      "anular",
      "no puedo ir",
      "cambiar la fecha",
      "cambiar fechas",
      "cambiar la reserva",
      "cambiar reserva",
      "modificar reserva",
    ],
    actionPresets: ["whatsapp_contact"],
  },
  {
    intent: "faq_ubicacion",
    category: "ubicacion_contacto",
    outputType: "faq",
    label: "Ubicación",
    question: "¿Dónde estáis?",
    answer:
      "Estamos en Camino de Santiago, 58, 30833 Sangonera La Verde, Murcia. También puedes contactar por WhatsApp o en info@somosmuyperros.com.",
    examples: [
      "¿dónde estáis?",
      "pasadme la dirección",
      "¿cómo llego al hotel canino?",
    ],
    synonyms: [
      "ubicacion",
      "ubicación",
      "direccion",
      "dirección",
      "como llegar",
      "murcia",
      "sangonera",
      "camino de santiago",
    ],
    actionPresets: ["contact_page"],
  },
  {
    intent: "faq_contacto",
    category: "ubicacion_contacto",
    outputType: "faq",
    label: "Contacto",
    question: "¿Cómo os contacto?",
    answer:
      "Puedes escribir al 682 62 11 77 o a info@somosmuyperros.com. Si ya quieres reservar, lo correcto es enviar antes el formulario.",
    examples: [
      "¿cómo os contacto?",
      "¿me pasáis el teléfono?",
      "¿qué email tenéis?",
    ],
    synonyms: [
      "telefono",
      "teléfono",
      "email",
      "correo",
      "contacto",
      "llamar",
      "whatsapp",
    ],
    actionPresets: ["whatsapp_contact", "contact_page"],
  },
  {
    intent: "faq_visitas_hotel",
    category: "visitas_recogidas",
    outputType: "faq",
    label: "Visitas al hotel",
    question: "¿Puedo visitar el hotel?",
    answer:
      "Sí, puedes visitar el hotel antes de confirmar. Las visitas se coordinan de lunes a jueves de 10:00 a 18:00.",
    examples: [
      "quiero visitar el hotel",
      "¿puedo ver las instalaciones?",
      "¿se puede visitar antes de reservar?",
    ],
    synonyms: [
      "visitar hotel",
      "ver instalaciones",
      "visita al centro",
      "conocer el hotel",
      "puedo ir antes",
      "visita hotel",
    ],
    actionPresets: ["whatsapp_contact"],
  },
  {
    intent: "faq_que_llevar",
    category: "requisitos_sanitarios",
    outputType: "faq",
    label: "Qué llevar",
    question: "¿Qué tengo que llevar?",
    answer:
      "Trae microchip y cartilla sanitaria, rabia anual al día y desparasitación interna y externa. Si toma medicación, trae la posología por escrito y la medicación o instrumentos necesarios. La comida está incluida, pero puedes traer su comida habitual, cama o juguetes si lo prefieres.",
    examples: [
      "¿qué tengo que llevar?",
      "¿hace falta llevar cama?",
      "¿tengo que llevar comida o comedero?",
    ],
    synonyms: [
      "que llevar",
      "qué llevar",
      "llevar cama",
      "llevar comida",
      "comederos",
      "cartilla",
      "medicacion",
    ],
  },
  {
    intent: "faq_recogida_familiar",
    category: "visitas_recogidas",
    outputType: "faq",
    label: "Recogida por familiar",
    question: "¿Puede recogerlo un familiar o amigo?",
    answer:
      "Sí, puede traerlo o recogerlo un familiar o amigo si nos facilitas su nombre completo y contacto, y siempre respetando el horario de recepción: 08:00-11:00 y 16:30-19:30.",
    examples: [
      "lo recoge mi padre",
      "¿puede recogerlo un amigo?",
      "¿puede llevarlo otra persona?",
    ],
    synonyms: [
      "familiar",
      "amigo",
      "otra persona",
      "recogerlo mi padre",
      "llevarlo mi madre",
      "nombre completo",
    ],
  },
  {
    intent: "faq_recomendacion_otro_sitio",
    category: "especiales_humano",
    outputType: "faq",
    label: "Recomendación externa",
    question: "¿Me recomendáis otro sitio?",
    answer:
      "Lo sentimos, no conocemos a nadie de confianza.",
    examples: [
      "¿me podéis recomendar otro sitio?",
      "si no tenéis hueco, ¿dónde puedo ir?",
      "¿conocéis otra residencia?",
    ],
    synonyms: [
      "recomendar otro sitio",
      "otra residencia",
      "alguien de confianza",
      "otro hotel canino",
    ],
  },
  {
    intent: "faq_climatizacion",
    category: "bienestar_estancia",
    outputType: "faq",
    label: "Temperatura y climatización",
    question: "¿Pasan frío o calor?",
    answer:
      "No. El resto del tiempo descansan en habitación individual climatizada, con hilo musical y vigilados por cámaras.",
    examples: [
      "¿pasan frío?",
      "¿pasan calor?",
      "¿las habitaciones están climatizadas?",
    ],
    synonyms: [
      "frio",
      "frío",
      "calor",
      "climatizada",
      "climatizacion",
      "habitación individual",
    ],
  },
  {
    intent: "faq_tiempo_aire_libre",
    category: "bienestar_estancia",
    outputType: "faq",
    label: "Tiempo al aire libre",
    question: "¿Cuánto tiempo salen al aire libre?",
    answer:
      "Salen al aire libre de 07:30 a 11:00 y de 16:30 a 19:30. El resto del tiempo descansan en habitación individual climatizada, con hilo musical y vigilados por cámaras.",
    examples: [
      "¿cuánto tiempo están fuera?",
      "¿salen al patio?",
      "¿horario al aire libre?",
    ],
    synonyms: [
      "aire libre",
      "patio",
      "fuera",
      "salen",
      "tiempo fuera",
      "jardin",
      "jardín",
    ],
  },
  {
    intent: "faq_seguimiento_estancia",
    category: "bienestar_estancia",
    outputType: "handoff",
    label: "Seguimiento de estancia",
    question: "¿Cómo ha pasado la noche?",
    answer:
      "No quiero inventarte un estado de la estancia. Lo revisamos con el equipo y te confirmamos por el canal adecuado.",
    examples: [
      "¿qué tal ha pasado la noche?",
      "¿ha comido?",
      "¿le habéis dado su medicación?",
      "¿ha llorado mucho?",
    ],
    synonyms: [
      "pasado la noche",
      "ha comido",
      "medicacion dada",
      "ha llorado",
      "como esta mi perro",
      "seguimiento estancia",
    ],
    actionPresets: ["whatsapp_contact"],
  },
  {
    intent: "workflow_disponibilidad",
    category: "reservas_confirmacion",
    outputType: "workflow",
    label: "Comprobación de disponibilidad",
    question: "¿Tenéis sitio para unas fechas concretas?",
    answer:
      "Para comprobar disponibilidad real necesitamos revisar la solicitud en el calendario de reservas con fechas y turnos. En producción eso entra por el formulario; en la demo también puedes verlo en la pantalla de reservas.",
    examples: [
      "¿tenéis sitio del 14 al 18 de abril?",
      "hay hueco para este fin de semana",
      "quiero saber si tenéis plaza del 2 al 5",
    ],
    synonyms: [
      "teneis sitio",
      "tenéis sitio",
      "hay hueco",
      "hay plaza",
      "disponibilidad",
      "fechas concretas",
      "del 14 al 18",
    ],
    actionPresets: ["booking_form", "reservations_demo"],
  },
  {
    intent: "workflow_reserva",
    category: "reservas_confirmacion",
    outputType: "workflow",
    label: "Reserva operativa",
    question: "Quiero reservar ahora",
    answer:
      "Si ya quieres tramitar una reserva, pásala por el formulario. Así revisamos disponibilidad, calculamos el precio correcto y te confirmamos por WhatsApp.",
    examples: [
      "quiero reservar",
      "quiero dejar al perro",
      "me lo podéis coger",
      "quiero hacer la reserva ya",
    ],
    synonyms: [
      "quiero reservar",
      "quiero dejarlo",
      "me lo podeis coger",
      "me lo podéis coger",
      "os lo llevo",
      "tramitar reserva",
    ],
    actionPresets: ["booking_form", "reservations_demo"],
  },
  {
    intent: "handoff_humano",
    category: "especiales_humano",
    outputType: "handoff",
    label: "Derivación humana",
    question: "Tengo un caso especial",
    answer:
      "Para este caso prefiero que lo revise una persona del equipo, así te damos una respuesta segura. Escríbenos o llámanos y lo vemos contigo.",
    examples: [
      "mi perro es muy especial te puedo llamar y contarte",
      "os tengo que explicar una cosa importante",
      "prefiero hablarlo con una persona",
    ],
    synonyms: [
      "caso especial",
      "te llamo y te explico",
      "te puedo llamar",
      "os puedo llamar",
      "hablar con una persona",
      "explicacion compleja",
      "explicación compleja",
    ],
    actionPresets: ["whatsapp_contact", "contact_page"],
  },
] as const;

export const FAQ_CATEGORY_DEFINITIONS: readonly FaqCategoryDefinition[] =
  FAQ_CATEGORY_BASE_DEFINITIONS.map((category) => ({
    ...category,
    intents: FAQ_KNOWLEDGE_ENTRIES.filter((entry) => entry.category === category.id),
  }));

export const FAQ_DEMO_PROMPTS: readonly FaqDemoPrompt[] = [
  {
    label: "Quiero reservar",
    question: "Quiero reservar",
    intent: "workflow_reserva",
    outputType: "workflow",
  },
  {
    label: "Cómo reservo",
    question: "¿Cómo hago una reserva?",
    intent: "faq_reserva_formulario",
    outputType: "faq",
  },
  {
    label: "WhatsApp",
    question: "¿Me confirmáis por WhatsApp?",
    intent: "faq_confirmacion_whatsapp",
    outputType: "faq",
  },
  {
    label: "Fuera de horario",
    question: "¿Puedo recogerlo a las 20:00?",
    intent: "faq_fuera_de_horario",
    outputType: "faq",
  },
  {
    label: "Precio 2 perros",
    question: "¿Cuánto cuesta 2 perros?",
    intent: "faq_precio_hotel",
    outputType: "faq",
  },
  {
    label: "Vacunas",
    question: "¿Qué vacunas pedís?",
    intent: "faq_vacunas",
    outputType: "faq",
  },
  {
    label: "¿Es recomendable?",
    question: "¿Es recomendable dejar a mi perro en una residencia?",
    intent: "faq_confianza_residencia",
    outputType: "faq",
  },
  {
    label: "Fotos",
    question: "¿Mandáis fotos?",
    intent: "faq_fotos",
    outputType: "faq",
  },
  {
    label: "Sitio en abril",
    question: "¿Tenéis sitio del 14 al 18 de abril?",
    intent: "workflow_disponibilidad",
    outputType: "workflow",
  },
  {
    label: "Caso especial",
    question: "Mi perro es muy especial, te puedo llamar y contarte",
    intent: "handoff_humano",
    outputType: "handoff",
  },
] as const;

export const FAQ_ROUTING_RULES = [
  {
    id: "chat_reserva_formulario",
    description: "Cuando el cliente quiere reservar por chat, el bot deriva siempre al formulario web.",
    outputType: "faq",
    intents: ["faq_reserva_formulario"] as const,
  },
  {
    id: "confianza_residencia_faq",
    description: "Las dudas sobre confianza, seguridad e idoneidad de la residencia se responden como FAQ, salvo que aparezcan señales especiales.",
    outputType: "faq",
    intents: ["faq_confianza_residencia"] as const,
  },
  {
    id: "disponibilidad_workflow",
    description: "Cuando el cliente pregunta por hueco o fechas concretas, se revisa con el calendario de disponibilidad.",
    outputType: "workflow",
    intents: ["workflow_disponibilidad", "workflow_reserva"] as const,
  },
  {
    id: "servicios_y_casos_especiales",
    description: "Servicios complementarios se responden como FAQ; los casos especiales fuera de lo normal pasan a humano.",
    outputType: "handoff",
    intents: ["handoff_humano"] as const,
  },
] as const;

export const HOTEL_FAQ_KNOWLEDGE_PACK: FaqKnowledgePack = {
  version: "2.1.0",
  locale: "es-ES",
  assumptions: [
    "Base estructurada con la nueva información funcional del cliente para reservas, horarios, salud, estancia y pagos.",
    "Cuando una pregunta requiere un dato vivo de la estancia o disponibilidad, se deriva al calendario de reservas o al equipo humano sin inventar estados.",
  ],
  fallbackAnswer:
    "Puedo orientarte con precios, horarios, requisitos y reservas. Si quieres cerrar una estancia, lo correcto es usar el formulario web para revisar disponibilidad y precio.",
  bookingFormUrl: HOTEL_DEMO_CONFIG.bookingFormUrl,
  categories: FAQ_CATEGORY_DEFINITIONS,
  entries: FAQ_KNOWLEDGE_ENTRIES,
  demoPrompts: FAQ_DEMO_PROMPTS,
};

export const FAQ_ENTRY_BY_INTENT = new Map<FaqIntentId, FaqKnowledgeEntry>(
  FAQ_KNOWLEDGE_ENTRIES.map((entry) => [entry.intent, entry]),
);

export const FAQ_CATEGORY_BY_ID = new Map<FaqCategoryId, FaqCategoryDefinition>(
  FAQ_CATEGORY_DEFINITIONS.map((category) => [category.id, category]),
);

export function getFaqEntry(intent: FaqIntentId): FaqKnowledgeEntry | undefined {
  return FAQ_ENTRY_BY_INTENT.get(intent);
}

export function getFaqCategory(categoryId: FaqCategoryId): FaqCategoryDefinition | undefined {
  return FAQ_CATEGORY_BY_ID.get(categoryId);
}

export function findFaqEntries(term: string): FaqKnowledgeEntry[] {
  const normalized = term.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return FAQ_KNOWLEDGE_ENTRIES.filter((entry) => {
    const haystacks = [entry.question, entry.answer, ...entry.examples, ...entry.synonyms]
      .join(" ")
      .toLowerCase();
    return haystacks.includes(normalized);
  });
}

function scoreFaqIntent(entry: FaqKnowledgeEntry, normalized: string) {
  const question = normalizeFaqText(entry.question);
  const haystacks = normalizeFaqText([entry.question, entry.answer, ...entry.examples, ...entry.synonyms].join(" "));
  const keywordHits = entry.synonyms.filter((keyword) =>
    normalized.includes(normalizeFaqText(keyword)),
  ).length;
  const questionHits = question === normalized ? 10 : Number(normalized.includes(question));
  const textHits = haystacks.includes(normalized) ? 6 : 0;
  const exampleHits = entry.examples.filter((example) =>
    normalized.includes(normalizeFaqText(example)),
  ).length * 2;
  return keywordHits * 3 + questionHits + textHits + exampleHits;
}

function resolveWidgetRoute(entry: FaqKnowledgeEntry): FaqWidgetRoute {
  if (entry.outputType === "handoff" || entry.intent === "handoff_humano") {
    return "humano";
  }

  if (
    entry.outputType === "workflow" ||
    entry.intent === "faq_reserva_formulario" ||
    entry.intent === "workflow_disponibilidad" ||
    entry.intent === "workflow_reserva"
  ) {
    return "formulario";
  }

  return "faq";
}

function buildWidgetCta(entry: FaqKnowledgeEntry) {
  const preset = entry.actionPresets?.[0];
  if (!preset) {
    return undefined;
  }

  if (preset === "booking_form") {
    return {
      label: "Ir al formulario",
      href: HOTEL_DEMO_CONFIG.bookingFormUrl,
    };
  }

  if (preset === "reservations_demo") {
    return {
      label: "Ver reservas demo",
      href: "/reservas-demo",
    };
  }

  if (preset === "whatsapp_contact") {
    return {
      label: "Abrir WhatsApp",
      href: HOTEL_DEMO_CONFIG.whatsappUrl,
    };
  }

  if (preset === "contact_page") {
    return {
      label: "Ver contacto",
      href: "https://somosmuyperros.com/contacto/",
    };
  }

  return undefined;
}

export function findFaqIntentByText(text: string): FaqIntentMatch | undefined {
  const normalized = normalizeFaqText(text);
  if (!normalized) {
    return undefined;
  }

  const scoredEntries = FAQ_KNOWLEDGE_ENTRIES
    .map((entry) => ({
      entry,
      score: scoreFaqIntent(entry, normalized),
    }))
    .sort((left, right) => right.score - left.score || left.entry.question.localeCompare(right.entry.question));

  const topMatch = scoredEntries[0];
  if (!topMatch || topMatch.score < 4) {
    return undefined;
  }

  const route = resolveWidgetRoute(topMatch.entry);
  return {
    id: topMatch.entry.intent,
    categoryId: topMatch.entry.category,
    question: topMatch.entry.question,
    answer: topMatch.entry.answer,
    route,
    cta: route === "formulario" ? buildWidgetCta(topMatch.entry) : undefined,
  };
}

# WhatsApp FAQ Knowledge Alignment Hotfix

Fecha: 2026-06-02

## Causa

El chat web resolvia las preguntas frecuentes mediante `src/lib/hotel/faq`, pero el canal WhatsApp usaba primero una NLU conversacional con un subconjunto reducido de FAQs. Por eso preguntas concretas como `¿y el pago?` podian caer en el fallback general, especialmente despues de una reserva o durante un flujo activo.

## Contrato V0

- La fuente compartida para respuestas FAQ es `src/lib/hotel/faq`.
- El puente para WhatsApp esta en `src/lib/hotel/knowledge/faq.ts`.
- WhatsApp consulta esa base compartida antes del fallback general para preguntas concretas.
- Una FAQ puede interrumpir temporalmente una reserva en curso; despues de responder, el bot retoma el dato pendiente.
- Los datos de reserva como fechas u horas no se tratan como FAQ aunque contengan palabras como `entrada` o `salida`.

## Fallback para pregunta concreta no cubierta

`Disculpa, para esta información un miembro de nuestro equipo se pondrá en contacto contigo para aclarar esta cuestión.`

## Respuesta de pago vigente

`El pago se hace a la llegada. Se puede pagar en efectivo, Bizum o transferencia. La señal no es obligatoria, aunque si se paga por transferencia el justificante debe enviarse antes cuando corresponda.`

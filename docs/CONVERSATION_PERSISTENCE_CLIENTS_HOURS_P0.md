# Hotfix P0: persistencia conversaciones, CLIENTES y horas

Fecha: 2026-06-02

## Causa P0 del panel

`/api/health` en production reportaba `persistence.provider=file-tmp`. En Vercel eso implica filesystem efimero por instancia/serverless runtime. Por tanto una conversacion podia aparecer tras el webhook y desaparecer al refrescar, navegar o caer en otra instancia aunque Registro de entrada no la borrase.

## Persistencia durable de conversaciones

Se anade `GoogleSheetsConversationStore`, activable con:

- `HOTEL_CONVERSATIONS_STORE_PROVIDER=google_sheets`
- `HOTEL_CONVERSATIONS_SHEET_NAME=CONVERSATIONS`

El store usa una pestana dedicada `CONVERSATIONS` en el spreadsheet existente. No mezcla conversaciones con `CLIENTES`, hojas mensuales, Registro de entrada ni reservas. Cada fila guarda una conversacion y su snapshot JSON completo para conservar mensajes, eventos, modo, archivado y contexto de reserva entre instancias.

## CLIENTES

El upsert posterior a reserva confirmada sigue bloqueando solo por coincidencias fuertes de telefono/email bloqueadas o ambiguas. Una coincidencia solo por nombre no bloquea el alta de un cliente nuevo confirmado.

## Registro de entrada

Registro de entrada no infiere `cliente habitual` por escritura en hoja mensual. Usa el resultado real de upsert CLIENTES:

- `nuevo cliente añadido`
- `cliente existente actualizado`
- `alta CLIENTES pendiente`
- `cliente habitual`
- `nuevo contacto`
- `revisión manual`

## Horas naturales

El flujo acepta o maneja sin fallback:

- `la hora me da igual`
- `Entrada y salida a las 11`
- `las dos a las 11`
- `ambas a las 11`
- `A las 11`
- `Entrada a las 11`
- `Salida a las 11`

Defaults usados desde configuracion existente:

- mañana: `HOTEL_SLOT_WINDOWS.morning.start`
- tarde: `HOTEL_SLOT_WINDOWS.afternoon.start`

Actualmente equivalen a `08:00` y `16:30`.

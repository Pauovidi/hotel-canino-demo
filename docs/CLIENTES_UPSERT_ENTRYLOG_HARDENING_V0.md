# CLIENTES upsert y Registro de entrada V0

Fecha: 2026-06-01

## Problema corregido

El alta en `CLIENTES` posterior a una reserva confirmada por WhatsApp podía saltarse si la resolución del directorio encontraba una coincidencia débil solo por nombre. Ese caso es útil para mostrar una revisión manual durante la conversación, pero no debe bloquear el alta de un nuevo cliente cuando la reserva ya se ha confirmado y el teléfono/email no coinciden de forma fuerte con ningún registro existente.

Además, el Registro de entrada infería `cliente habitual` por tener escritura en la hoja mensual. Eso mezclaba dos conceptos distintos: reserva procesada en el cuadrante y estado real del cliente en `CLIENTES`.

## Comportamiento nuevo

- El upsert posterior a reserva confirmada usa coincidencias fuertes por teléfono y email.
- Una coincidencia solo por nombre no impide crear una nueva fila en `CLIENTES`.
- Si el teléfono o email ya existen, no se duplica la fila.
- Si el contacto exacto está bloqueado o ambiguo, no se crea fila y queda como revisión.
- Si la reserva ya se escribió en Sheets pero falla `CLIENTES`, la reserva sigue confirmada y se marca `alta CLIENTES pendiente`.
- El `ReservationRecord` guarda el resultado del upsert para que Registro de entrada y Panel muestren el estado correcto.

## Estados visibles

- `cliente habitual`: cliente existente por match fuerte previo.
- `nuevo cliente añadido`: fila creada en `CLIENTES` tras reserva confirmada.
- `cliente existente actualizado`: el upsert encontró un teléfono/email existente y no duplicó.
- `alta CLIENTES pendiente`: upsert fallido, ambiguo, bloqueado o teléfono inválido.
- `revisión manual`: reserva marcada para revisión operativa.

## Desacoplamiento Registro / Conversaciones

Las acciones del Registro de entrada solo escriben en `hotel-entry-log-state.json`. Los tests cubren colisiones de ruta contra `hotel-conversations.json` y el store de dominio para asegurar que gestionar, quitar, reabrir o limpiar registros no modifica conversaciones ni reservas.

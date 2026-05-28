# CLIENTES: alta controlada desde reserva WhatsApp V0

## Regla de producto

- Un contacto nuevo que solo escribe no se añade a `CLIENTES`.
- Un contacto nuevo se puede añadir a `CLIENTES` solo después de una reserva confirmada correctamente.
- Un contacto existente no se duplica.
- Un contacto ambiguo o bloqueado no se añade ni confirma reserva automáticamente.

## Flujo implementado

1. WhatsApp crea conversación y resuelve ClientDirectory.
2. La solicitud de reserva completa crea una propuesta pendiente.
3. La confirmación explícita revalida disponibilidad.
4. Si la escritura en Sheets y el ReservationRecord son correctos, se ejecuta el upsert de `CLIENTES`.
5. El panel actualiza la conversación a cliente conocido si el upsert crea o encuentra cliente.

## Nombre pendiente

V0 usa fallback controlado si no hay nombre responsable fiable:

`Contacto WhatsApp ****NNNN`

También crea el evento `client_directory_created_pending_name` y añade la advertencia `client_name_pending_review`.
No se pide ni se guarda NIF.

## Smoke real opcional

No se ejecuta por defecto. Para validar escritura real de reserva y CLIENTES con datos QA:

```powershell
$env:HOTEL_QA_ALLOW_REAL_SHEETS_WRITE="true"
$env:HOTEL_QA_CLEANUP_REAL_SHEETS="true"
$env:HOTEL_QA_ALLOW_REAL_CLIENTS_WRITE="true"
$env:HOTEL_QA_CLEANUP_REAL_CLIENTS="true"
npm run smoke:conversation:sheets-real
```

Sin `HOTEL_QA_ALLOW_REAL_CLIENTS_WRITE=true`, el smoke real de Sheets no toca `CLIENTES`.

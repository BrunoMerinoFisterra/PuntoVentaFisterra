# Finnegans FileSender — Puntos de Venta

Portal web para subir un archivo Excel y enviar su contenido como puntos de venta a Finnegans (`POST /api/puntoVenta`).

## Cómo usarlo

```bash
npm install       # solo la primera vez
npm start         # levanta el portal en http://localhost:4600
```

Abrí `http://localhost:4600` en el navegador:

1. **Seleccionar archivo** — arrastrá o elegí el `.xlsx`. Opcionalmente indicá un `EmpresaID` por defecto (se usa cuando la columna `SUCURSAL` viene vacía) y un `TransaccionSubtipoID` por defecto.
2. **Vista previa** — el archivo se agrupa por `NUMERO`: cada grupo es un punto de venta y cada fila un ítem. Con "Ver JSON" podés inspeccionar el payload exacto antes de enviar. Destildá los que no quieras mandar.
3. **Enviar** — envía los seleccionados uno por uno. Cada fila muestra su estado (verde = creado, rojo = error; clic en el estado rojo muestra la respuesta completa de Finnegans).

## Formato del Excel

Una fila por ítem. Filas con el mismo `NUMERO` forman un mismo punto de venta. Columnas usadas:

| Columna | Campo API |
|---|---|
| NUMERO | agrupador de comprobante |
| COMPROBANTE | `IdentificacionExterna` |
| FECHA | `Fecha` (dd/mm/aaaa según la doc de puntoVenta) |
| FECHACOMPROBANTE | `FechaComprobante` |
| FECHABASEVENCIMIENTO | `FechaBaseVencimiento` |
| CLIENTE | `OrganizacionID` |
| CONDICIONPAGO | `CondicionPagoID` |
| MONEDA | `MonedaID` |
| TIPO DE COMPROBANTE | `ComprobanteTipoImpositivoID` (ej: FC) |
| TRANSACCIONSUBTIPO | `TransaccionSubtipoID` (o el valor por defecto de la UI) |
| WORKFLOW | `WorkflowID` |
| DESCRIPCION | `Descripcion` |
| SUCURSAL | `EmpresaID` (o el valor por defecto de la UI) |
| VENDEDOR | `PersonaIDVendedor` |
| MOTIVO_CODIGO | `MotivoComprobanteID` |
| MONEDA_COTIZACION + COTIZACION | `OperacionCotizaciones` |
| COMPROBANTEADICIONAL | `PuntoVentaItemsTarjeta` — el primer token es el código de operación bancaria (ej: "9520 Visa" → `OperacionBancariaID: 9520`), con `ImporteACobrar` = suma de los ítems |
| PRODUCTO | ítem: `ProductoID` |
| DESCRIPCIONITEM | ítem: `Descripcion` |
| CANTIDAD | ítem: `CantidadWorkflow` |
| PRECIO | ítem: `Precio` |
| DESCUENTO1 | ítem: `Descuento1` |

Columnas vacías se omiten del payload. El mapeo completo vive en [mapping.js](mapping.js) — si Finnegans rechaza un campo, se ajusta ahí.

## Configuración

Credenciales en `.env` (no se exponen al navegador; el envío pasa por el servidor local):

```
FINNEGANS_CLIENT_ID=...
FINNEGANS_CLIENT_SECRET=...
PORT=4600
```

## Estructura

- `server.js` — Express: sirve el portal, `POST /api/parse` (parsea y arma la vista previa) y `POST /api/enviar` (obtiene el token OAuth de Teamplace y postea cada punto de venta a Finnegans).
- `mapping.js` — parseo del Excel y armado del payload (editable).
- `public/` — frontend (HTML/CSS/JS sin frameworks).
- `ejemplo-pedido-venta.xlsx` — archivo de ejemplo usado para desarrollar el mapeo.

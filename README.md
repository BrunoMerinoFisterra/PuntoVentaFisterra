# PuntoVentaFinnegans

Comparación de dos payloads JSON para crear un comprobante de **punto de venta** en la API de Finnegans (`POST /api/puntoVenta` / `/api/puntoVentaIntegraciones`, base `https://api.finneg.com/api`, autenticación por query param `ACCESS_TOKEN`).

## Archivos

| Archivo | Contenido |
|---|---|
| [json-1-venta-web-228432.json](json-1-venta-web-228432.json) | Venta web #228432 — 4 productos, IVA 10,5% discriminado, dimensiones contables, cobro por cuenta contable ("Otros"). Usa nomenclatura con sufijo `Codigo`. |
| [json-2-factura-b-30411.json](json-2-factura-b-30411.json) | Factura B-00003-00030411 — venta de servicios (minibar hotelero), pago con tarjeta Visa, sin IVA discriminado. Sigue la nomenclatura oficial con sufijo `ID`. |

## Conclusión principal

Verificado contra la especificación OpenAPI oficial de Finnegans (`puntoVenta` y `puntoVentaIntegraciones`): **el JSON 2 sigue la nomenclatura documentada** (sufijos `ID`, fechas `dd/mm/aaaa`). El JSON 1 usa una variante con sufijos `Codigo` y fechas ISO (`aaaa-mm-dd`) que no figura en el spec oficial.

## Diferencias de nomenclatura (mismo campo, distinto nombre)

| Concepto | JSON 1 (venta web) | JSON 2 (factura B) | Spec oficial |
|---|---|---|---|
| Cliente | `ClienteCodigo` | `OrganizacionID` (CUIT) | `OrganizacionID` |
| Condición de pago | `CondicionPagoCodigo` | `CondicionPagoID` | `CondicionPagoID` |
| Moneda | `MonedaCodigo` | `MonedaID` | `MonedaID` |
| Empresa | `EmpresaCodigo` | `EmpresaID` | `EmpresaID` |
| Workflow | `WorkflowCodigo: null` | `WorkflowID: "VTASSERV"` | `WorkflowID` — **obligatorio** |
| Vendedor | `VendedorCodigo` | `PersonaIDVendedor` | `PersonaIDVendedor` |
| Ítems | `Productos[]` con `ProductoCodigo`, `Cantidad` | `OperacionItems[]` con `ProductoID`, `CantidadWorkflow` | `OperacionItems` / `ProductoID` / `CantidadWorkflow` |
| Impuestos | `Conceptos[]` con `ConceptoCodigo`, `ImporteEditable` | (sin conceptos) | `OperacionConceptos[]` con `ConceptoID`, `Control1` |
| Cotizaciones | `Cotizaciones[]` con `MonedaCodigo` | `OperacionCotizaciones[]` con `MonedaID` | `OperacionCotizaciones` / `MonedaID` |
| Fechas | `2026-04-07` (ISO) | `01/07/2026` | `dd/mm/aaaa` |

## Contenido exclusivo de cada JSON

**Solo en JSON 1:**

- Impuestos discriminados: IVA 10,5% ($27.291,49 sobre base gravada $259.918,90).
- Dimensiones contables por producto: 100% a `DIMPARFIN → VEM08` y `DIMCTC → RTO 70`.
- Totales explícitos como strings (`Total`, `TotalBruto`, `TotalConceptos`, `TotalPagos`, `Vuelto`, `TotalRetenciones`) — existen en el spec de `puntoVenta`.
- Cotización de `DOL` (1393) además de `PES`.
- Campos AFIP (`CAINumero`, `ObtenerCAEAutomaticamente`, `MotivoComprobante`, FCE) y arrays vacíos de retenciones y otros medios de pago.
- Cobro por "Otros": cuenta contable `1.1.01.002.012`, Debe, $287.210,39. Usa `CuentaCodigo`/`ImporteACobrar`, pero el spec de `PuntoVentaItemsOtros` define `CuentaID`/`ImporteMonTransaccion`.

**Solo en JSON 2:**

- Cobro con tarjeta: `PuntoVentaItemsTarjeta` con `OperacionBancariaID: "9520"` (Visa) por $9.390,50 — coincide exactamente con el spec.
- `Descripcion` por ítem ("MINIBAR"); repite el mismo `ProductoID` (`GROUP_10`) con precios distintos.
- No discrimina IVA — consistente con una factura B (IVA incluido en el precio; la identificación externa empieza con "B").

## Consistencia aritmética (ambos cierran)

- **JSON 1**: 27.582,75 + 93.656,83 + 71.639,20 + 67.040,12 = 259.918,90 = `TotalBruto` ✓; IVA 10,5% = 27.291,49 ✓; 259.918,90 + 27.291,49 = 287.210,39 = `Total` = `TotalPagos` = importe del cobro ✓.
- **JSON 2**: 3.130,17 + 6.260,33 = 9.390,50 = importe de la tarjeta ✓.

## Puntos de atención en el JSON 1

1. **`WorkflowCodigo: null`** — el spec marca el workflow como obligatorio. En el JSON 2 viene informado (`VTASSERV`).
2. **Nomenclatura no documentada** — todos los sufijos `Codigo` (y `Cantidad` en vez de `CantidadWorkflow`, `Conceptos` en vez de `OperacionConceptos`, `Cotizaciones` en vez de `OperacionCotizaciones`). Si este payload falla contra Finnegans, la causa más probable es esta diferencia de nombres más el formato de fecha.
3. **`VendedorCodigo: "RTO 70"`** coincide con el código de distribución de `DIMCTC` — puede ser intencional (centro de costo = vendedor), pero el campo documentado es `PersonaIDVendedor` y en el JSON 2 apunta a una persona (`GTC_02`).

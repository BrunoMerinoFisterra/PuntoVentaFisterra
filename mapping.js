/**
 * Mapeo de columnas del Excel al payload de POST /api/puntoVenta (Finnegans).
 *
 * El Excel tiene una fila por ítem. Las filas que comparten NUMERO forman
 * un mismo punto de venta: la cabecera se toma de la primera fila del grupo
 * y cada fila aporta un elemento de OperacionItems.
 *
 * Referencia de campos: OpenAPI "puntoVenta" (esquema oficial de Finnegans,
 * núcleo Cuentas a Cobrar). Según la doc, Fecha y FechaBaseVencimiento van
 * en formato dd/mm/aaaa. Si Finnegans rechaza algún campo, ajustá el mapeo
 * acá — la UI muestra el payload exacto y la respuesta de la API.
 */

const XLSX = require('xlsx');

/** Convierte fecha (Date | serial Excel | string) a partes {y, m, d}. */
function toDateParts(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? { y: parsed.y, m: parsed.m, d: parsed.d } : null;
  }
  const str = String(value).trim();
  // "2026-07-01 00:00:00" o "2026-07-01T00:00:00"
  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  // "01/07/2026" (dd/mm/aaaa)
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return { y: +dmy[3], m: +dmy[2], d: +dmy[1] };
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Formato dd/mm/aaaa — el que pide la doc de puntoVenta para Fecha. */
function toDmyDate(value) {
  const p = toDateParts(value);
  return p ? `${pad2(p.d)}/${pad2(p.m)}/${p.y}` : null;
}

/** Formato aaaa-mm-dd — por si algún campo lo necesita. */
function toIsoDate(value) {
  const p = toDateParts(value);
  return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

/** Elimina claves null/undefined/'' y arrays vacíos (mismo patrón que FSTrack). */
function cleanObject(obj) {
  if (Array.isArray(obj)) {
    const arr = obj.map(cleanObject).filter((v) => v != null);
    return arr.length ? arr : null;
  }
  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleaned = cleanObject(value);
      if (cleaned !== null && cleaned !== undefined && cleaned !== '') out[key] = cleaned;
    }
    return Object.keys(out).length ? out : null;
  }
  return obj === '' ? null : obj;
}

/** Normaliza nombres de columna: mayúsculas, sin espacios extra. */
function normalizeHeader(header) {
  return String(header || '').trim().toUpperCase();
}

/**
 * Parsea el workbook y devuelve las filas como objetos {COLUMNA: valor}
 * usando la primera hoja (ignora hojas de metadata tipo XDO_METADATA).
 */
function parseRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames.find((n) => !n.toUpperCase().includes('METADATA'));
  if (!sheetName) throw new Error('El archivo no tiene hojas de datos.');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: true });
  return rows.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) normalized[normalizeHeader(key)] = value;
    return normalized;
  });
}

/**
 * Medio de pago con tarjeta a partir de COMPROBANTEADICIONAL ("9520 Visa"):
 * el primer token numérico es el código de operación bancaria.
 */
function buildItemsTarjeta(head, totalPedido, moneda) {
  const adicional = toStringOrNull(head.COMPROBANTEADICIONAL);
  if (!adicional) return null;
  const codigo = adicional.split(/\s+/)[0];
  return [
    {
      OperacionBancariaID: codigo,
      ImporteACobrar: totalPedido,
      MonedaCobroCodigo: moneda,
      Descripcion: adicional,
    },
  ];
}

/**
 * Agrupa las filas por NUMERO (fallback: COMPROBANTE) y construye un
 * payload de puntoVenta por grupo.
 *
 * @param rows filas normalizadas del Excel
 * @param defaults valores por defecto opcionales desde la UI:
 *   { empresaId, subtipoId } — se usan cuando la columna correspondiente
 *   (SUCURSAL / TRANSACCIONSUBTIPO) viene vacía.
 */
function buildPedidos(rows, defaults = {}) {
  const grupos = new Map();
  rows.forEach((row, index) => {
    const key = toStringOrNull(row.NUMERO) ?? toStringOrNull(row.COMPROBANTE) ?? `fila-${index}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push({ row, excelRow: index + 2 }); // +2: 1 de header, 1 porque es 1-indexado
  });

  const pedidos = [];
  for (const [numero, filas] of grupos) {
    const head = filas[0].row;
    const identificacion = toStringOrNull(head.COMPROBANTE) ?? `PV-${numero}`;
    const moneda = toStringOrNull(head.MONEDA);

    const total = Math.round(
      filas.reduce((sum, { row }) => {
        const cant = toNumberOrNull(row.CANTIDAD) ?? 0;
        const precio = toNumberOrNull(row.PRECIO) ?? 0;
        return sum + cant * precio;
      }, 0) * 100
    ) / 100;

    const payload = cleanObject({
      IdentificacionExterna: identificacion,
      Fecha: toDmyDate(head.FECHA),
      FechaComprobante: toDmyDate(head.FECHACOMPROBANTE),
      FechaBaseVencimiento: toDmyDate(head.FECHABASEVENCIMIENTO),
      OrganizacionID: toStringOrNull(head.CLIENTE),
      CondicionPagoID: toStringOrNull(head.CONDICIONPAGO),
      MonedaID: moneda,
      ComprobanteTipoImpositivoID: toStringOrNull(head['TIPO DE COMPROBANTE']),
      TransaccionSubtipoID:
        toStringOrNull(head.TRANSACCIONSUBTIPO) ?? toStringOrNull(defaults.subtipoId),
      WorkflowID: toStringOrNull(head.WORKFLOW),
      Descripcion: toStringOrNull(head.DESCRIPCION),
      EmpresaID: toStringOrNull(head.SUCURSAL) ?? toStringOrNull(defaults.empresaId),
      PersonaIDVendedor: toStringOrNull(head.VENDEDOR),
      MotivoComprobanteID: toStringOrNull(head.MOTIVO_CODIGO),
      OperacionCotizaciones:
        toStringOrNull(head.MONEDA_COTIZACION) != null
          ? [{ MonedaID: toStringOrNull(head.MONEDA_COTIZACION), Cotizacion: toNumberOrNull(head.COTIZACION) }]
          : null,
      OperacionItems: filas.map(({ row }) => ({
        ProductoID: toStringOrNull(row.PRODUCTO),
        Descripcion: toStringOrNull(row.DESCRIPCIONITEM),
        CantidadWorkflow: toNumberOrNull(row.CANTIDAD),
        Precio: toNumberOrNull(row.PRECIO),
        Descuento1: toNumberOrNull(row.DESCUENTO1),
      })),
      PuntoVentaItemsTarjeta: buildItemsTarjeta(head, total, moneda),
    });

    pedidos.push({
      numero,
      comprobante: toStringOrNull(head.COMPROBANTE),
      cliente: toStringOrNull(head.CLIENTE),
      descripcion: toStringOrNull(head.DESCRIPCION),
      fecha: toDmyDate(head.FECHA),
      items: filas.length,
      filasExcel: filas.map((f) => f.excelRow),
      total,
      payload,
    });
  }
  return pedidos;
}

module.exports = { parseRows, buildPedidos, cleanObject, toDmyDate, toIsoDate };

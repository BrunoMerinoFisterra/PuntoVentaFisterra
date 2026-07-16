/**
 * Mapeo de columnas del Excel al payload de POST /api/puntoVenta (Finnegans).
 *
 * El Excel tiene una fila por ítem. Las filas que comparten NUMERO forman
 * un mismo punto de venta: la cabecera se toma de la primera fila del grupo
 * y cada fila aporta un elemento de Productos.
 *
 * La estructura replica un JSON validado contra el tenant (2026-07):
 *   - fechas en aaaa-mm-dd (la doc decía dd/mm/aaaa, pero lo que funciona es ISO)
 *   - alias de campos (ClienteCodigo, Productos, Cantidad, ...)
 *   - subtipo PTOVTA-FV-OPERA, WorkflowCodigo omitido
 *   - pago en PuntoVentaItemsOtros contra la cuenta TCV (no en ItemsTarjeta)
 *   - Conceptos TAX_* en cero y totales como strings
 */

const XLSX = require('xlsx');

const CONFIG = {
  TRANSACCION_TIPO: 'OPER',
  // Subtipo del circuito de punto de venta (sobreescribible desde la UI)
  SUBTIPO_DEFAULT: 'PTOVTA-FV-OPERA',
  // Tipo impositivo según la letra del comprobante (B-00003-... → B).
  // Letras sin entrada (ej: T) hacen que el campo se omita (es opcional).
  TIPO_IMPOSITIVO_POR_LETRA: { A: '001', B: '006' },
  // Cuenta puente para el cobro con tarjeta (PuntoVentaItemsOtros)
  CUENTA_PAGO_OTROS: 'TCV',
  // Conceptos impositivos que el circuito espera (en cero, calcula Finnegans)
  CONCEPTOS_DEFAULT: ['TAX_1', 'TAX_4', 'TAX_3', 'TAX_5'],
  // Los códigos de vendedor del Excel (251, 263, ...) no existen en el
  // tenant, así que el vendedor se omite. Poné un código válido (ej:
  // 'GTC_02') para enviarlo fijo en todos los comprobantes.
  VENDEDOR_DEFAULT: null,
};

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
  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return { y: +dmy[3], m: +dmy[2], d: +dmy[1] };
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Formato aaaa-mm-dd (el que acepta el tenant en la práctica). */
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

const round2 = (n) => Math.round(n * 100) / 100;

/** Elimina claves null/undefined/'' y arrays vacíos (0 y false se conservan). */
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

/** Tipo impositivo a partir de la letra del comprobante ("B-00003-..." → "006"). */
function tipoImpositivoDeComprobante(comprobante) {
  if (!comprobante) return null;
  const letra = String(comprobante).trim().charAt(0).toUpperCase();
  return CONFIG.TIPO_IMPOSITIVO_POR_LETRA[letra] ?? null;
}

/**
 * Agrupa las filas por NUMERO (fallback: COMPROBANTE) y construye un
 * payload de puntoVenta por grupo.
 *
 * @param rows filas normalizadas del Excel
 * @param defaults valores opcionales desde la UI: { empresaId, subtipoId }
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
    const comprobante = toStringOrNull(head.COMPROBANTE);
    const moneda = toStringOrNull(head.MONEDA);

    const total = round2(
      filas.reduce((sum, { row }) => {
        const cant = toNumberOrNull(row.CANTIDAD) ?? 0;
        const precio = toNumberOrNull(row.PRECIO) ?? 0;
        return sum + cant * precio;
      }, 0)
    );

    const payload = cleanObject({
      IdentificacionExterna: comprobante ?? `PV-${numero}`,
      Fecha: toIsoDate(head.FECHA),
      FechaComprobante: toIsoDate(head.FECHACOMPROBANTE),
      FechaBaseVencimiento: toIsoDate(head.FECHABASEVENCIMIENTO),
      ClienteCodigo: toStringOrNull(head.CLIENTE),
      CondicionPagoCodigo: toStringOrNull(head.CONDICIONPAGO),
      MonedaCodigo: moneda,
      ComprobanteTipoImpositivoID: tipoImpositivoDeComprobante(comprobante),
      TransaccionTipoCodigo: CONFIG.TRANSACCION_TIPO,
      TransaccionSubtipoCodigo:
        toStringOrNull(head.TRANSACCIONSUBTIPO) ??
        toStringOrNull(defaults.subtipoId) ??
        CONFIG.SUBTIPO_DEFAULT,
      Descripcion: toStringOrNull(head.DESCRIPCION),
      NumeroComprobante: comprobante,
      EmpresaCodigo: toStringOrNull(head.SUCURSAL) ?? toStringOrNull(defaults.empresaId),
      VendedorCodigo: CONFIG.VENDEDOR_DEFAULT,
      Productos: filas.map(({ row }) => {
        const cantidad = toNumberOrNull(row.CANTIDAD);
        const precio = toNumberOrNull(row.PRECIO);
        return {
          ProductoCodigo: toStringOrNull(row.PRODUCTO),
          Precio: precio,
          Cantidad: cantidad,
          Descripcion: toStringOrNull(row.DESCRIPCIONITEM),
          PrecioTipo: 0,
          Descuento1: toNumberOrNull(row.DESCUENTO1) ?? 0,
          Descuento2: toNumberOrNull(row.DESCUENTO2) ?? 0,
          ImporteExento: precio != null && cantidad != null ? round2(precio * cantidad) : null,
        };
      }),
      Conceptos: CONFIG.CONCEPTOS_DEFAULT.map((codigo) => ({
        ConceptoCodigo: codigo,
        ImporteEditable: false,
        ConceptoImporte: 0,
        ConceptoImporteGravado: 0,
      })),
      PuntoVentaItemsOtros: [
        {
          CuentaCodigo: CONFIG.CUENTA_PAGO_OTROS,
          DebeHaber: 1,
          ImporteACobrar: total,
          MonedaCobroCodigo: moneda,
        },
      ],
      Cotizaciones:
        toStringOrNull(head.MONEDA_COTIZACION) != null
          ? [{ MonedaCodigo: toStringOrNull(head.MONEDA_COTIZACION), Cotizacion: toNumberOrNull(head.COTIZACION) }]
          : null,
      Vuelto: '0.00',
      TotalBruto: total.toFixed(2),
      TotalConceptos: '0.00',
      Total: total.toFixed(2),
      TotalRetenciones: '0',
      TotalPagos: total.toFixed(2),
    });

    pedidos.push({
      numero,
      comprobante,
      cliente: toStringOrNull(head.CLIENTE),
      descripcion: toStringOrNull(head.DESCRIPCION),
      fecha: toIsoDate(head.FECHA),
      items: filas.length,
      filasExcel: filas.map((f) => f.excelRow),
      total,
      payload,
    });
  }
  return pedidos;
}

module.exports = { parseRows, buildPedidos, cleanObject, toIsoDate, CONFIG };

// Reglas puras del módulo de caja (spec 9.3). Sin acceso a la base: se testean solas.
// Todos los montos de este módulo son enteros en centavos; las fechas son 'YYYY-MM-DD' (hora local del negocio).

const { sumarDias } = require('./reglas');

const MAX_DIAS_RANGO = 366;

// ---- Dinero ----

/** Pesos (número o texto, hasta 2 decimales) a centavos enteros. */
function aCentavos(pesos) {
  return Math.round(Number(pesos) * 100);
}

function aPesos(centavos) {
  return centavos / 100;
}

// ---- Precio del bowl (RN-C2) ----

/**
 * Precio vigente en una fecha: la fila del historial con la mayor vigente_desde <= fecha.
 * Devuelve null si la fecha es anterior al primer precio o no hay historial.
 */
function precioVigente(historial, fecha) {
  let vigente = null;
  for (const p of historial) {
    if (p.vigente_desde <= fecha && (!vigente || p.vigente_desde > vigente.vigente_desde)) vigente = p;
  }
  return vigente;
}

// ---- Cierre de día trabajado (RN-C3) ----

/**
 * Calcula un cierre de día trabajado. Entradas y salidas en centavos (las cantidades de bowls, enteros).
 * - ingresos = bowls × precio de cada medio de pago
 * - efectivo esperado = fondo inicial + ingresos en efectivo − gastos (los gastos se pagan en efectivo)
 * - diferencia = efectivo contado − esperado (negativa = faltante)
 * - utilidad del día = ventas − gastos (no incluye el fondo ni la diferencia)
 */
function calcularCierre({ fondoInicial, bowlsEfectivo, bowlsTransferencia, precioEfectivo, precioTransferencia, gastos, efectivoContado }) {
  const ingresosEfectivo = bowlsEfectivo * precioEfectivo;
  const ingresosTransferencia = bowlsTransferencia * precioTransferencia;
  const efectivoEsperado = fondoInicial + ingresosEfectivo - gastos;
  const ventas = ingresosEfectivo + ingresosTransferencia;
  return {
    ingresosEfectivo,
    ingresosTransferencia,
    efectivoEsperado,
    diferencia: efectivoContado - efectivoEsperado,
    ventas,
    utilidad: ventas - gastos,
  };
}

// ---- Resultado (RN-C6) ----

/** Ventas totales, utilidad relativa (sin gastos generales) y resultado (con gastos generales) de un período. */
function calcularResultado({ ventasMayorista, ventasMinorista, gastosPuntosVenta, gastosGenerales }) {
  const ventasTotales = ventasMayorista + ventasMinorista;
  const utilidadRelativa = ventasTotales - gastosPuntosVenta;
  return { ventasTotales, utilidadRelativa, resultado: utilidadRelativa - gastosGenerales };
}

// ---- Fechas y rangos ----

/** true si es un texto 'YYYY-MM-DD' que corresponde a un día real del calendario. */
function fechaValida(f) {
  if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(f + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

/** Mensaje de error si la fecha es inválida o futura (respecto de `hoy`); null si está bien. */
function validarFecha(fecha, hoy) {
  if (!fechaValida(fecha)) return 'La fecha es inválida: usá el formato AAAA-MM-DD.';
  if (fecha > hoy) return 'La fecha no puede ser futura.';
  return null;
}

function diasEntre(desde, hasta) {
  return Math.round((new Date(hasta + 'T00:00:00Z') - new Date(desde + 'T00:00:00Z')) / 86400000) + 1;
}

/** Mensaje de error si el rango no es válido (fechas reales, desde <= hasta, máximo 366 días); null si está bien. */
function validarRango(desde, hasta) {
  if (!fechaValida(desde) || !fechaValida(hasta)) return 'Las fechas "desde" y "hasta" deben tener el formato AAAA-MM-DD.';
  if (desde > hasta) return 'La fecha "desde" no puede ser posterior a "hasta".';
  if (diasEntre(desde, hasta) > MAX_DIAS_RANGO) return `El rango no puede superar los ${MAX_DIAS_RANGO} días.`;
  return null;
}

/** Todas las fechas del rango, inclusive. */
function diasDelRango(desde, hasta) {
  const dias = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) dias.push(f);
  return dias;
}

// ---- Semanas (lunes a domingo) y períodos ----

function diaSemana(fecha) {
  return new Date(fecha + 'T12:00:00Z').getUTCDay(); // 0 = domingo
}

/** Lunes de la semana (lunes a domingo) a la que pertenece la fecha. */
function lunesDe(fecha) {
  return sumarDias(fecha, -((diaSemana(fecha) + 6) % 7));
}

/** Semana ISO 8601 ('2026-W46'): empieza el lunes y pertenece al año de su jueves. */
function semanaDe(fecha) {
  const jueves = sumarDias(lunesDe(fecha), 3);
  const anio = Number(jueves.slice(0, 4));
  const dias = Math.round((new Date(jueves + 'T00:00:00Z') - new Date(`${anio}-01-01T00:00:00Z`)) / 86400000);
  return `${anio}-W${String(Math.floor(dias / 7) + 1).padStart(2, '0')}`;
}

const AGRUPACIONES = ['total', 'dia', 'semana', 'mes'];

/** Etiqueta del período al que pertenece una fecha: 'total' | '2026-11-12' | '2026-W46' | '2026-11'. */
function periodoDe(fecha, agrupar) {
  switch (agrupar) {
    case 'total': return 'total';
    case 'dia': return fecha;
    case 'semana': return semanaDe(fecha);
    case 'mes': return fecha.slice(0, 7);
    default: throw new Error(`agrupar inválido: ${agrupar}`);
  }
}

/** Períodos que cubren el rango, con los límites efectivos dentro del rango (una semana o mes parcial usa solo sus días del rango). */
function periodosDelRango(desde, hasta, agrupar) {
  if (!AGRUPACIONES.includes(agrupar)) throw new Error(`agrupar inválido: ${agrupar}. Usá ${AGRUPACIONES.join(', ')}.`);
  const periodos = [];
  for (const dia of diasDelRango(desde, hasta)) {
    const periodo = periodoDe(dia, agrupar);
    const ultimo = periodos[periodos.length - 1];
    if (ultimo && ultimo.periodo === periodo) ultimo.hasta = dia;
    else periodos.push({ periodo, desde: dia, hasta: dia });
  }
  return periodos;
}

// ---- Días sin cierre (RN-C7) ----

/**
 * Días sin cierre de UN punto de venta. `cierres` son todos sus cierres activos ({ fecha, tipo }), no solo los del rango.
 * Se evalúan los días entre su primer cierre y ayer (hoy no, porque puede estar abierto), dentro de [desde, hasta].
 * Un día no se avisa si hay un cierre (de cualquier tipo) o si el último cierre anterior fue un fin de temporada.
 */
function diasSinCierre({ cierres, desde, hasta, hoy }) {
  if (!cierres.length) return [];
  const ordenados = [...cierres].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  const primero = ordenados[0].fecha;
  const ayer = sumarDias(hoy, -1);
  const inicio = desde > primero ? desde : primero;
  const fin = hasta < ayer ? hasta : ayer;
  if (inicio > fin) return [];

  const conCierre = new Set(ordenados.map(c => c.fecha));
  const faltantes = [];
  for (const dia of diasDelRango(inicio, fin)) {
    if (conCierre.has(dia)) continue;
    let anterior = null;
    for (const c of ordenados) { if (c.fecha < dia) anterior = c; else break; }
    if (anterior && anterior.tipo === 'fin_temporada') continue;
    faltantes.push(dia);
  }
  return faltantes;
}

module.exports = {
  MAX_DIAS_RANGO, AGRUPACIONES,
  aCentavos, aPesos, precioVigente, calcularCierre, calcularResultado,
  fechaValida, validarFecha, validarRango, diasDelRango, lunesDe, semanaDe, periodoDe, periodosDelRango, diasSinCierre,
};

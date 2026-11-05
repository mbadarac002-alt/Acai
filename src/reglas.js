// Reglas de negocio: fecha de entrega y descuentos. Funciones puras, fáciles de testear.

const TZ = process.env.TZ_NEGOCIO || 'America/Argentina/Buenos_Aires';

/** Fecha/hora local del negocio: { fecha: 'YYYY-MM-DD', hora: 'HH:MM', diaSemana: 0..6 (0=domingo) } */
function ahoraLocal(date = new Date(), tz = TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    fecha: `${parts.year}-${parts.month}-${parts.day}`,
    hora: `${parts.hour}:${parts.minute}`,
    diaSemana: dias[parts.weekday],
  };
}

function sumarDias(fechaISO, dias) {
  const d = new Date(fechaISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Viernes más cercano a la fecha del pedido.
 * Si el pedido se hace un viernes antes de la hora de corte, se entrega ese mismo día;
 * si es después, el viernes siguiente.
 */
function calcularFechaEntrega({ fecha, hora, diaSemana }, horaCorte) {
  const VIERNES = 5;
  if (diaSemana === VIERNES) {
    return hora < horaCorte ? fecha : sumarDias(fecha, 7);
  }
  const dias = (VIERNES - diaSemana + 7) % 7;
  return sumarDias(fecha, dias);
}

/** Mes calendario ('YYYY-MM') de una fecha 'YYYY-MM-DD'. */
function mesDe(fechaISO) {
  return fechaISO.slice(0, 7);
}

/**
 * Calcula precio y descuento.
 * baldesPrevios: baldes del cliente en pedidos anteriores del mismo mes calendario.
 * El pedido actual cuenta para llegar al umbral; el descuento se aplica al total del pedido.
 */
function calcularPrecio({ cantidad, baldesPrevios, config }) {
  const acumulados = baldesPrevios + cantidad;
  const aplica = config.umbral_baldes > 0 && acumulados >= config.umbral_baldes;
  const subtotal = round2(cantidad * config.precio_balde);
  const descuentoPct = aplica ? config.descuento_pct : 0;
  const descuentoMonto = round2(subtotal * descuentoPct / 100);
  return {
    precio_unitario: config.precio_balde,
    subtotal,
    baldes_acumulados: acumulados,
    descuento_pct: descuentoPct,
    descuento_monto: descuentoMonto,
    total: round2(subtotal - descuentoMonto),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { TZ, ahoraLocal, sumarDias, calcularFechaEntrega, mesDe, calcularPrecio };

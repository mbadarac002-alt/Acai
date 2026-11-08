const test = require('node:test');
const assert = require('node:assert');
const { ahoraLocal, calcularFechaEntrega, calcularPrecio, mesDe, nombreDia } = require('../src/reglas');

// 2026-11-02 es lunes, 2026-11-03 martes, 2026-11-06 viernes.
const dia = (fecha, hora, diaSemana) => ({ fecha, hora, diaSemana });

test('entrega: lunes -> martes siguiente', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-02', '09:00', 1), '12:00'), '2026-11-03');
});
test('entrega: martes antes de la hora de corte -> mismo martes', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-03', '11:59', 2), '12:00'), '2026-11-03');
});
test('entrega: martes en/después de la hora de corte -> viernes', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-03', '12:00', 2), '12:00'), '2026-11-06');
});
test('entrega: miércoles y jueves -> viernes', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-04', '09:00', 3), '12:00'), '2026-11-06');
  assert.equal(calcularFechaEntrega(dia('2026-11-05', '23:59', 4), '12:00'), '2026-11-06');
});
test('entrega: viernes antes de la hora de corte -> mismo viernes', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-06', '11:59', 5), '12:00'), '2026-11-06');
});
test('entrega: viernes en/después de la hora de corte -> martes siguiente', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-06', '12:00', 5), '12:00'), '2026-11-10');
});
test('entrega: sábado y domingo -> martes siguiente', () => {
  assert.equal(calcularFechaEntrega(dia('2026-11-07', '10:00', 6), '12:00'), '2026-11-10');
  assert.equal(calcularFechaEntrega(dia('2026-11-08', '10:00', 0), '12:00'), '2026-11-10');
});
test('nombreDia devuelve el día de la semana en español', () => {
  assert.equal(nombreDia('2026-11-10'), 'martes');
  assert.equal(nombreDia('2026-11-13'), 'viernes');
});
test('ahoraLocal usa la zona horaria del negocio', () => {
  // 2026-11-06 14:30 UTC = 11:30 en Buenos Aires (viernes)
  const a = ahoraLocal(new Date('2026-11-06T14:30:00Z'), 'America/Argentina/Buenos_Aires');
  assert.deepEqual(a, { fecha: '2026-11-06', hora: '11:30', diaSemana: 5 });
});

const config = { precio_balde: 1000, umbral_baldes: 20, descuento_pct: 10 };

test('precio sin descuento bajo el umbral', () => {
  const r = calcularPrecio({ cantidad: 5, baldesPrevios: 10, config });
  assert.equal(r.baldes_acumulados, 15);
  assert.equal(r.descuento_pct, 0);
  assert.equal(r.total, 5000);
});
test('el pedido actual cuenta para alcanzar el umbral y el descuento va sobre todo el pedido', () => {
  const r = calcularPrecio({ cantidad: 5, baldesPrevios: 15, config });
  assert.equal(r.baldes_acumulados, 20);
  assert.equal(r.descuento_pct, 10);
  assert.equal(r.subtotal, 5000);
  assert.equal(r.descuento_monto, 500);
  assert.equal(r.total, 4500);
});
test('un solo pedido que alcanza el umbral tiene descuento', () => {
  const r = calcularPrecio({ cantidad: 20, baldesPrevios: 0, config });
  assert.equal(r.descuento_pct, 10);
  assert.equal(r.total, 18000);
});
test('umbral 0 desactiva el descuento', () => {
  const r = calcularPrecio({ cantidad: 50, baldesPrevios: 0, config: { ...config, umbral_baldes: 0 } });
  assert.equal(r.descuento_pct, 0);
});
test('mesDe devuelve el mes calendario', () => {
  assert.equal(mesDe('2026-11-30'), '2026-11');
  assert.equal(mesDe('2026-12-01'), '2026-12');
});

// T8 · Resumen total de un rango (spec 9.3 RN-C1, RN-C6 y criterios de 9.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-resumen-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cfgBase = { precio_balde: 1000, umbral_baldes: 0, descuento_pct: 0, hora_corte: '12:00', email_propietario: 'dueno@example.com' };

test.before(async () => {
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  await adm('/config', 'PUT', { ...cfgBase, precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2020-01-01' });
});
test.after(() => { server.close(); });

const resumen = async (desde, hasta, extra = '') => {
  const r = await adm(`/caja/resumen?desde=${desde}&hasta=${hasta}${extra}`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const j = await r.json();
  return { ...j, p: j.periodos[0] };
};

// Pedido mayorista cobrado en una fecha. El precio del balde es $1.000, así que el total es 1.000 × cantidad.
const cliente = { nombre: 'Luis Gómez', dni: '28999111', direccion: 'Calle 1', telefono: '11 4444-0000' };
async function pedido({ efectivo = 0, transferencia = 0, cobrado = null, fechaPedido = null, estado = 'cobrado' }) {
  const total = efectivo + transferencia;
  const id = (await (await post('/api/pedidos', { ...cliente, cantidad: Math.round(total / 1000) })).json()).pedido_id;
  if (estado === 'cobrado') {
    const r = await adm('/pedidos/' + id, 'PATCH', { estado: 'cobrado', pago_efectivo: efectivo, pago_transferencia: transferencia });
    assert.equal(r.status, 200);
    db.prepare('UPDATE pedidos SET fecha_cobro = ? WHERE id = ?').run(cobrado, id);
  } else if (estado !== 'recibido') {
    await adm('/pedidos/' + id, 'PATCH', { estado });
  }
  if (fechaPedido) db.prepare('UPDATE pedidos SET fecha_pedido = ? WHERE id = ?').run(fechaPedido, id);
  return id;
}
const cierre = async (body) => {
  const r = await adm('/caja/cierres', 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return r.json();
};
const gasto = async (body) => {
  const r = await adm('/caja/gastos', 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return r.json();
};
const ceros = { efectivo: 0, transferencia: 0, total: 0, pedidos: 0 };

test('un rango sin movimientos devuelve todo en cero, con los tres puntos de venta', async () => {
  const { p, desde, hasta, agrupar } = await resumen('2025-01-01', '2025-01-31');
  assert.deepEqual([desde, hasta, agrupar], ['2025-01-01', '2025-01-31', 'total']);
  assert.equal(p.periodo, 'total');
  assert.deepEqual([p.desde, p.hasta], ['2025-01-01', '2025-01-31']);
  assert.deepEqual(p.mayorista, ceros);
  assert.equal(p.minorista.ventas_total, 0);
  assert.deepEqual(p.minorista.puntos.map(x => x.nombre), ['Miramar 1', 'Miramar 2', 'Chapadmalal']);
  assert.deepEqual(p.gastos_generales, { corrientes: 0, stock: 0, total: 0, por_categoria: [] });
  assert.deepEqual([p.ventas_totales, p.gastos_puntos_venta, p.utilidad_relativa, p.resultado], [0, 0, 0, 0]);
});

// ---- Mayorista (RN-C1) ----

test('mayorista: un pedido cobrado hoy con $3.000 en efectivo y $2.000 por transferencia suma 5.000 y 1 pedido', async () => {
  await pedido({ efectivo: 3000, transferencia: 2000, cobrado: '2025-02-10 11:30' });
  const { p } = await resumen('2025-02-10', '2025-02-10');
  assert.deepEqual(p.mayorista, { efectivo: 3000, transferencia: 2000, total: 5000, pedidos: 1 });
  assert.equal(p.ventas_totales, 5000);
});

test('mayorista: cuenta en el día del cobro, no en el del pedido; el rango es inclusivo hasta el final del día', async () => {
  await pedido({ efectivo: 1000, cobrado: '2025-03-07 18:00', fechaPedido: '2025-03-03' }); // pedido el lunes, cobrado el viernes
  assert.equal((await resumen('2025-03-03', '2025-03-03')).p.mayorista.pedidos, 0);
  assert.equal((await resumen('2025-03-07', '2025-03-07')).p.mayorista.total, 1000);

  await pedido({ efectivo: 2000, cobrado: '2025-03-20 23:59' });
  await pedido({ efectivo: 4000, cobrado: '2025-03-21 00:00' });
  const dia20 = (await resumen('2025-03-20', '2025-03-20')).p.mayorista;
  assert.equal(dia20.total, 2000);
  const ambos = (await resumen('2025-03-20', '2025-03-21')).p.mayorista;
  assert.deepEqual([ambos.total, ambos.pedidos], [6000, 2]);
});

test('mayorista: un pedido cobrado cuyo cobro se corrige usa los montos nuevos y la fecha de cobro original', async () => {
  const id = await pedido({ efectivo: 3000, cobrado: '2025-04-10 10:00' });
  assert.equal((await adm(`/pedidos/${id}/cobro`, 'PATCH', { pago_efectivo: 500, pago_transferencia: 2500 })).status, 200);
  const { p } = await resumen('2025-04-10', '2025-04-10');
  assert.deepEqual(p.mayorista, { efectivo: 500, transferencia: 2500, total: 3000, pedidos: 1 });
});

test('mayorista: un pedido cobrado que se elimina deja de sumar', async () => {
  const id = await pedido({ efectivo: 3000, cobrado: '2025-05-10 10:00' });
  assert.equal((await resumen('2025-05-10', '2025-05-10')).p.mayorista.total, 3000);
  assert.equal((await adm('/pedidos/' + id, 'DELETE')).status, 200);
  assert.deepEqual((await resumen('2025-05-10', '2025-05-10')).p.mayorista, ceros);
});

test('mayorista: los pedidos recibidos, en proceso o entregados no suman en ningún resumen', async () => {
  for (const estado of ['recibido', 'en_proceso', 'entregado']) await pedido({ efectivo: 1000, estado });
  // todos los cobros de este archivo tienen fecha de 2025: el año completo suma solo pedidos cobrados y activos
  const { p } = await resumen('2025-01-01', '2025-12-31');
  const cobrados = db.prepare("SELECT COUNT(*) n FROM pedidos WHERE estado = 'cobrado' AND eliminado_en IS NULL").get().n;
  assert.equal(p.mayorista.pedidos, cobrados);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM pedidos WHERE estado <> 'cobrado' AND eliminado_en IS NULL").get().n >= 3);
});

test('mayorista: los montos con centavos se suman sin errores de redondeo', async () => {
  await pedido({ efectivo: 1000, transferencia: 2000, cobrado: '2025-06-10 10:00' });
  const id = (await db.prepare('SELECT MAX(id) id FROM pedidos').get()).id;
  await adm(`/pedidos/${id}/cobro`, 'PATCH', { pago_efectivo: 1200.1, pago_transferencia: 1799.9 });
  await pedido({ efectivo: 1000, transferencia: 0, cobrado: '2025-06-10 12:00' });
  const lastId = db.prepare('SELECT MAX(id) id FROM pedidos').get().id;
  await adm(`/pedidos/${lastId}/cobro`, 'PATCH', { pago_efectivo: 300.2, pago_transferencia: 699.8 });
  const { p } = await resumen('2025-06-10', '2025-06-10');
  assert.deepEqual(p.mayorista, { efectivo: 1500.3, transferencia: 2499.7, total: 4000, pedidos: 2 });
});

// ---- Minorista (RN-C3) ----

test('minorista: suma bowls, ventas por medio de pago, gastos y utilidad de los cierres, y desglosa por punto de venta', async () => {
  await cierre({ punto_venta_id: 1, fecha: '2025-07-10', tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 5, bowls_transferencia: 2, gastos: 3000, efectivo_contado: 22000 });
  await cierre({ punto_venta_id: 2, fecha: '2025-07-10', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 1, bowls_transferencia: 1, gastos: 0, efectivo_contado: 4000 });
  await cierre({ punto_venta_id: 3, fecha: '2025-07-10', tipo: 'no_trabajado', motivo: 'lluvia' });
  const { p } = await resumen('2025-07-10', '2025-07-10');
  const m = p.minorista;
  assert.deepEqual([m.bowls_efectivo, m.bowls_transferencia], [6, 3]);
  assert.deepEqual([m.ventas_efectivo, m.ventas_transferencia, m.ventas_total], [24000, 13500, 37500]);
  assert.deepEqual([m.gastos, m.utilidad_relativa], [3000, 34500]);
  const [m1, m2, ch] = m.puntos;
  assert.deepEqual([m1.nombre, m1.ventas_total, m1.gastos, m1.utilidad_relativa, m1.dias_trabajados, m1.dias_no_trabajados], ['Miramar 1', 29000, 3000, 26000, 1, 0]);
  assert.deepEqual([m2.ventas_total, m2.utilidad_relativa, m2.dias_trabajados], [8500, 8500, 1]);
  assert.deepEqual([ch.ventas_total, ch.dias_trabajados, ch.dias_no_trabajados], [0, 0, 1]);
  assert.deepEqual([p.ventas_totales, p.gastos_puntos_venta, p.utilidad_relativa, p.resultado], [37500, 3000, 34500, 34500]);
});

test('minorista: un fin de temporada cuenta como día no trabajado y no suma ventas', async () => {
  await cierre({ punto_venta_id: 3, fecha: '2025-07-11', tipo: 'fin_temporada' });
  const ch = (await resumen('2025-07-11', '2025-07-11')).p.minorista.puntos[2];
  assert.deepEqual([ch.dias_trabajados, ch.dias_no_trabajados, ch.ventas_total], [0, 1, 0]);
});

test('minorista: la diferencia de caja se informa por punto de venta pero no entra en el resultado', async () => {
  await cierre({ punto_venta_id: 1, fecha: '2025-07-15', tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 5, bowls_transferencia: 2, gastos: 3000, efectivo_contado: 21500, nota_diferencia: 'faltó un vuelto' });
  const { p } = await resumen('2025-07-15', '2025-07-15');
  assert.equal(p.minorista.puntos[0].diferencia_caja, -500);
  assert.equal(p.minorista.puntos[1].diferencia_caja, 0);
  assert.equal(p.utilidad_relativa, 26000, 'ventas 29.000 − gastos 3.000, sin la diferencia');
  assert.equal(p.resultado, 26000);
});

test('minorista: un cierre eliminado no cuenta', async () => {
  const c = await cierre({ punto_venta_id: 2, fecha: '2025-07-20', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 2, bowls_transferencia: 0, gastos: 0, efectivo_contado: 8000 });
  assert.equal((await resumen('2025-07-20', '2025-07-20')).p.minorista.ventas_total, 8000);
  await adm('/caja/cierres/' + c.id, 'DELETE', { motivo: 'error' });
  const { p } = await resumen('2025-07-20', '2025-07-20');
  assert.equal(p.minorista.ventas_total, 0);
  assert.equal(p.minorista.puntos[1].dias_trabajados, 0);
});

test('minorista: un cierre corregido cuenta con sus valores nuevos', async () => {
  const c = await cierre({ punto_venta_id: 2, fecha: '2025-07-21', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 2, bowls_transferencia: 0, gastos: 0, efectivo_contado: 8000 });
  await adm('/caja/cierres/' + c.id, 'PUT', { punto_venta_id: 2, fecha: '2025-07-21', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 3, bowls_transferencia: 0, gastos: 0, efectivo_contado: 12000 });
  assert.equal((await resumen('2025-07-21', '2025-07-21')).p.minorista.ventas_total, 12000);
});

// ---- Gastos generales (RN-C5) ----

test('gastos generales: $50.000 de mercadería del 28/11 cuentan íntegros en noviembre, como stock, y no en diciembre', async () => {
  await gasto({ fecha: '2025-11-28', monto: 50000, categoria_id: 1 });
  await gasto({ fecha: '2025-11-05', monto: 8000, categoria_id: 3 }); // publicidad
  const nov = (await resumen('2025-11-01', '2025-11-30')).p.gastos_generales;
  assert.deepEqual([nov.stock, nov.corrientes, nov.total], [50000, 8000, 58000]);
  assert.deepEqual(nov.por_categoria, [
    { categoria: 'mercadería', tipo: 'stock', monto: 50000 },
    { categoria: 'publicidad', tipo: 'corriente', monto: 8000 },
  ]);
  const dic = (await resumen('2025-12-01', '2025-12-31')).p.gastos_generales;
  assert.equal(dic.total, 0);
});

test('gastos generales: un gasto eliminado no cuenta', async () => {
  const g = await gasto({ fecha: '2025-08-10', monto: 1000, categoria_id: 7 });
  assert.equal((await resumen('2025-08-10', '2025-08-10')).p.gastos_generales.total, 1000);
  await adm('/caja/gastos/' + g.id, 'DELETE', { motivo: 'error' });
  assert.equal((await resumen('2025-08-10', '2025-08-10')).p.gastos_generales.total, 0);
});

// ---- Resultado (RN-C6) ----

test('resultado: mayorista 5.000 + minorista 12.000 − gastos 2.000 − generales 4.000 = 11.000', async () => {
  await pedido({ efectivo: 3000, transferencia: 2000, cobrado: '2025-10-10 10:00' });
  await cierre({ punto_venta_id: 1, fecha: '2025-10-10', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 3, bowls_transferencia: 0, gastos: 2000, efectivo_contado: 10000 });
  await gasto({ fecha: '2025-10-15', monto: 4000, categoria_id: 4 });
  const { p } = await resumen('2025-10-01', '2025-10-31');
  assert.equal(p.ventas_totales, 17000);
  assert.equal(p.gastos_puntos_venta, 2000);
  assert.equal(p.utilidad_relativa, 15000);
  assert.equal(p.gastos_generales.total, 4000);
  assert.equal(p.resultado, 11000);
});

test('resultado: una semana sin ventas con un gasto general de $4.000 da utilidad 0 y resultado −4.000', async () => {
  await gasto({ fecha: '2025-09-03', monto: 4000, categoria_id: 6 });
  const { p } = await resumen('2025-09-01', '2025-09-07');
  assert.equal(p.utilidad_relativa, 0);
  assert.equal(p.resultado, -4000);
});

test('resultado: los gastos generales del período se descuentan aunque no haya ventas en él', async () => {
  const { p } = await resumen('2025-09-01', '2025-09-30');
  assert.equal(p.resultado, -p.gastos_generales.total + p.utilidad_relativa);
});

// ---- Parámetros y acceso ----

test('parámetros inválidos responden 400', async () => {
  for (const q of [
    '', 'desde=2025-01-01', 'hasta=2025-01-31', 'desde=2025-13-01&hasta=2025-01-31', 'desde=2025-02-01&hasta=2025-01-01',
    'desde=2024-01-01&hasta=2025-12-31', 'desde=2025-01-01&hasta=2025-01-31&agrupar=anio',
  ]) {
    const r = await adm('/caja/resumen?' + q);
    assert.equal(r.status, 400, q);
    assert.ok(Array.isArray((await r.json()).errores), q);
  }
});

test('un rango de exactamente 366 días es válido; agrupar=total es el valor por defecto', async () => {
  const r = await adm('/caja/resumen?desde=2025-01-01&hasta=2026-01-01&agrupar=total');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).agrupar, 'total');
});

test('el resumen requiere autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/caja/resumen?desde=2025-01-01&hasta=2025-01-31')).status, 401);
});

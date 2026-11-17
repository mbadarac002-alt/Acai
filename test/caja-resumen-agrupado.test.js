// T9 · Resumen agrupado por día, semana y mes (spec 9.3 RN-C6 y criterios de 9.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-agrupado-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cfgBase = { precio_balde: 1000, umbral_baldes: 0, descuento_pct: 0, hora_corte: '12:00', email_propietario: 'dueno@example.com' };
const cliente = { nombre: 'Luis Gómez', dni: '28999111', direccion: 'Calle 1', telefono: '11 4444-0000' };

const pedidoCobrado = async (efectivo, transferencia, cobrado) => {
  const id = (await (await post('/api/pedidos', { ...cliente, cantidad: (efectivo + transferencia) / 1000 })).json()).pedido_id;
  await adm('/pedidos/' + id, 'PATCH', { estado: 'cobrado', pago_efectivo: efectivo, pago_transferencia: transferencia });
  db.prepare('UPDATE pedidos SET fecha_cobro = ? WHERE id = ?').run(cobrado, id);
};
const cierre = async (body) => { const r = await adm('/caja/cierres', 'POST', body); assert.equal(r.status, 201, JSON.stringify(await r.clone().json())); return r.json(); };
const gasto = async (body) => { const r = await adm('/caja/gastos', 'POST', body); assert.equal(r.status, 201); return r.json(); };
const resumen = async (desde, hasta, agrupar) => {
  const r = await adm(`/caja/resumen?desde=${desde}&hasta=${hasta}&agrupar=${agrupar}`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return r.json();
};
const centavos = n => Math.round(n * 100);
const sumar = (periodos, f) => periodos.reduce((s, p) => s + centavos(f(p)), 0);

let cierreDic;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  await adm('/config', 'PUT', { ...cfgBase, precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2020-01-01' });

  // Semana 46 (lun 10 a dom 16 de noviembre de 2025)
  await pedidoCobrado(3000, 2000, '2025-11-12 23:59');
  await cierre({ punto_venta_id: 1, fecha: '2025-11-12', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 3, bowls_transferencia: 0, gastos: 2000, efectivo_contado: 10000 });
  await gasto({ fecha: '2025-11-12', monto: 4000, categoria_id: 4 });
  await cierre({ punto_venta_id: 2, fecha: '2025-11-14', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 1, bowls_transferencia: 1, gastos: 0, efectivo_contado: 4000 });
  await cierre({ punto_venta_id: 3, fecha: '2025-11-15', tipo: 'no_trabajado', motivo: 'lluvia' });
  // Semana 47 (17 a 23) y semana 48 (24 a 30)
  await gasto({ fecha: '2025-11-18', monto: 1000, categoria_id: 1 });
  await gasto({ fecha: '2025-11-30', monto: 500, categoria_id: 7 });
  // Semana 49 (1 a 7 de diciembre)
  cierreDic = await cierre({ punto_venta_id: 1, fecha: '2025-12-02', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 2, bowls_transferencia: 0, gastos: 0, efectivo_contado: 8000 });
});
test.after(() => { server.close(); });

test('por día: un período por cada día del rango, también los días sin movimientos, en orden', async () => {
  const { agrupar, periodos } = await resumen('2025-11-10', '2025-12-07', 'dia');
  assert.equal(agrupar, 'dia');
  assert.equal(periodos.length, 28);
  assert.equal(periodos[0].periodo, '2025-11-10');
  assert.equal(periodos[27].periodo, '2025-12-07');
  assert.ok(periodos.every(p => p.desde === p.periodo && p.hasta === p.periodo), 'cada período es de un solo día');
  const fechas = periodos.map(p => p.periodo);
  assert.deepEqual(fechas, [...fechas].sort(), 'en orden');
  // un día sin ningún movimiento aparece con todo en cero
  const vacio = periodos.find(p => p.periodo === '2025-11-11');
  assert.deepEqual([vacio.ventas_totales, vacio.utilidad_relativa, vacio.resultado, vacio.gastos_generales.total, vacio.mayorista.pedidos], [0, 0, 0, 0, 0]);
  assert.equal(vacio.minorista.puntos.length, 3);
});

test('por día: el 12/11 reproduce el ejemplo del spec (5.000 + 12.000 − 2.000 − 4.000 = 11.000)', async () => {
  const dia = (await resumen('2025-11-10', '2025-12-07', 'dia')).periodos.find(p => p.periodo === '2025-11-12');
  assert.equal(dia.mayorista.total, 5000);
  assert.equal(dia.minorista.ventas_total, 12000);
  assert.equal(dia.ventas_totales, 17000);
  assert.equal(dia.utilidad_relativa, 15000);
  assert.equal(dia.gastos_generales.total, 4000);
  assert.equal(dia.resultado, 11000);
});

test('por semana: de lunes a domingo, con etiqueta ISO y los gastos en la semana de su fecha', async () => {
  const { periodos } = await resumen('2025-11-10', '2025-12-07', 'semana');
  assert.deepEqual(periodos.map(p => [p.periodo, p.desde, p.hasta]), [
    ['2025-W46', '2025-11-10', '2025-11-16'],
    ['2025-W47', '2025-11-17', '2025-11-23'],
    ['2025-W48', '2025-11-24', '2025-11-30'],
    ['2025-W49', '2025-12-01', '2025-12-07'],
  ]);
  const [w46, w47, w48, w49] = periodos;
  assert.equal(w46.ventas_totales, 5000 + 12000 + 8500);
  assert.equal(w46.resultado, 25500 - 2000 - 4000);
  assert.deepEqual([w47.ventas_totales, w47.gastos_generales.stock, w47.resultado], [0, 1000, -1000]);
  assert.equal(w48.resultado, -500);
  assert.equal(w49.ventas_totales, 8000);
});

test('por semana: una semana parcial usa solo los días dentro del rango', async () => {
  // del miércoles 12 al martes 18: W46 (12 a 16) y W47 (17 y 18); el gasto del 30/11 queda afuera
  const { periodos } = await resumen('2025-11-12', '2025-11-18', 'semana');
  assert.deepEqual(periodos.map(p => [p.periodo, p.desde, p.hasta]), [
    ['2025-W46', '2025-11-12', '2025-11-16'],
    ['2025-W47', '2025-11-17', '2025-11-18'],
  ]);
  assert.equal(periodos[1].gastos_generales.total, 1000);
  // el gasto del 18/11 queda fuera de un rango que termina el 17: esa semana parcial existe, pero en cero
  const corto = (await resumen('2025-11-12', '2025-11-17', 'semana')).periodos;
  assert.deepEqual(corto.map(p => [p.periodo, p.desde, p.hasta]), [['2025-W46', '2025-11-12', '2025-11-16'], ['2025-W47', '2025-11-17', '2025-11-17']]);
  assert.equal(corto[1].gastos_generales.total, 0);
});

test('por mes: meses calendario con los límites efectivos dentro del rango', async () => {
  const { periodos } = await resumen('2025-11-10', '2025-12-07', 'mes');
  assert.deepEqual(periodos.map(p => [p.periodo, p.desde, p.hasta]), [
    ['2025-11', '2025-11-10', '2025-11-30'],
    ['2025-12', '2025-12-01', '2025-12-07'],
  ]);
  const [nov, dic] = periodos;
  assert.equal(nov.ventas_totales, 25500);
  assert.equal(nov.gastos_generales.total, 5500);
  assert.equal(nov.resultado, 25500 - 2000 - 5500);
  assert.equal(dic.ventas_totales, 8000);
  assert.equal(dic.resultado, 8000);
});

test('la suma de los períodos es igual al total del rango (ventas totales, utilidad relativa y resultado)', async () => {
  const total = (await resumen('2025-11-10', '2025-12-07', 'total')).periodos;
  assert.equal(total.length, 1);
  assert.equal(total[0].periodo, 'total');
  const t = total[0];
  for (const agrupar of ['dia', 'semana', 'mes']) {
    const { periodos } = await resumen('2025-11-10', '2025-12-07', agrupar);
    assert.equal(sumar(periodos, p => p.ventas_totales), centavos(t.ventas_totales), `${agrupar}: ventas totales`);
    assert.equal(sumar(periodos, p => p.utilidad_relativa), centavos(t.utilidad_relativa), `${agrupar}: utilidad`);
    assert.equal(sumar(periodos, p => p.resultado), centavos(t.resultado), `${agrupar}: resultado`);
    assert.equal(sumar(periodos, p => p.gastos_generales.total), centavos(t.gastos_generales.total), `${agrupar}: gastos generales`);
    assert.equal(sumar(periodos, p => p.mayorista.total), centavos(t.mayorista.total), `${agrupar}: mayorista`);
    assert.equal(periodos.reduce((s, p) => s + p.mayorista.pedidos, 0), t.mayorista.pedidos, `${agrupar}: pedidos`);
    assert.equal(periodos.reduce((s, p) => s + p.minorista.bowls_efectivo, 0), t.minorista.bowls_efectivo, `${agrupar}: bowls`);
  }
  assert.equal(t.resultado, 25500 + 8000 - 2000 - 5500);
});

test('los períodos sin actividad aparecen con todo en cero, también con semana y mes', async () => {
  const dias = (await resumen('2025-01-01', '2025-01-07', 'dia')).periodos;
  assert.equal(dias.length, 7);
  assert.ok(dias.every(p => p.ventas_totales === 0 && p.resultado === 0));
  // enero de 2025: semanas W01 (1 a 5), W02, W03, W04 y W05 (27 a 31)
  const semanas = (await resumen('2025-01-01', '2025-01-31', 'semana')).periodos;
  assert.deepEqual(semanas.map(p => [p.periodo, p.desde, p.hasta]), [
    ['2025-W01', '2025-01-01', '2025-01-05'], ['2025-W02', '2025-01-06', '2025-01-12'], ['2025-W03', '2025-01-13', '2025-01-19'],
    ['2025-W04', '2025-01-20', '2025-01-26'], ['2025-W05', '2025-01-27', '2025-01-31'],
  ]);
  const meses = (await resumen('2025-01-01', '2025-01-31', 'mes')).periodos;
  assert.deepEqual(meses.map(p => p.periodo), ['2025-01']);
  assert.equal(meses[0].resultado, 0);
  assert.equal((await resumen('2025-01-01', '2025-01-31', 'total')).periodos.length, 1);
});

test('un día no trabajado se ve en su día, con ventas en cero', async () => {
  const dia = (await resumen('2025-11-15', '2025-11-15', 'dia')).periodos;
  assert.equal(dia.length, 1);
  assert.equal(dia[0].ventas_totales, 0);
  assert.equal(dia[0].minorista.puntos[2].dias_no_trabajados, 1);
});

test('un cierre eliminado deja de contar: su día queda en cero', async () => {
  await adm('/caja/cierres/' + cierreDic.id, 'DELETE', { motivo: 'error' });
  const dias = (await resumen('2025-12-01', '2025-12-07', 'dia')).periodos;
  assert.equal(dias.length, 7);
  const d2 = dias.find(p => p.periodo === '2025-12-02');
  assert.deepEqual([d2.ventas_totales, d2.resultado, d2.minorista.puntos[0].dias_trabajados], [0, 0, 0]);
  const w49 = (await resumen('2025-11-10', '2025-12-07', 'semana')).periodos.find(p => p.periodo === '2025-W49');
  assert.equal(w49.resultado, 0);
});

test('agrupación inválida responde 400', async () => {
  const r = await adm('/caja/resumen?desde=2025-11-01&hasta=2025-11-30&agrupar=anio');
  assert.equal(r.status, 400);
});

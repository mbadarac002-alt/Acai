// T10 · Avisos de días sin cierre y días no trabajados en el resumen (spec 9.3 RN-C7 y criterios de 9.7).
// Las fechas son relativas a hoy porque los avisos cuentan hasta ayer. Con H = hoy: H-6 es "el 10" y hoy "el 16" del ejemplo del spec.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-avisos-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { ahoraLocal, sumarDias } = require('../src/reglas');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
const cfgBase = { precio_balde: 1000, umbral_baldes: 0, descuento_pct: 0, hora_corte: '12:00', email_propietario: 'dueno@example.com' };
test.before(async () => {
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  await adm('/config', 'PUT', { ...cfgBase, precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2020-01-01' });
});
test.after(() => { server.close(); });

const H = ahoraLocal().fecha;
const d = n => sumarDias(H, n); // d(-1) = ayer
const limpiar = () => db.prepare('DELETE FROM cierres_caja').run();
const crear = async (pv, fecha, tipo = 'trabajado', extra = {}) => {
  const body = tipo === 'trabajado'
    ? { punto_venta_id: pv, fecha, tipo, fondo_inicial: 0, bowls_efectivo: 0, bowls_transferencia: 0, gastos: 0, efectivo_contado: 0 }
    : { punto_venta_id: pv, fecha, tipo, motivo: tipo === 'no_trabajado' ? 'lluvia' : undefined };
  const r = await adm('/caja/cierres', 'POST', { ...body, ...extra });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return r.json();
};
const resumen = async (desde, hasta, agrupar = 'total') => {
  const r = await adm(`/caja/resumen?desde=${desde}&hasta=${hasta}&agrupar=${agrupar}`);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return r.json();
};
const avisoDe = (res, pv) => res.avisos.find(a => a.punto_venta_id === pv);

test('faltan 4 días: se avisan los intermedios y ayer, pero no hoy; el resultado se calcula igual', async () => {
  limpiar();
  await crear(3, d(-6));
  await crear(3, d(-2));
  const res = await resumen(d(-6), H);
  const a = avisoDe(res, 3);
  assert.equal(a.nombre, 'Chapadmalal');
  assert.equal(a.dias_sin_cierre, 4);
  assert.deepEqual(a.fechas, [d(-5), d(-4), d(-3), d(-1)]);
  assert.equal(res.periodos.length, 1, 'el resumen igual se calcula');
  assert.equal(res.periodos[0].periodo, 'total');
});

test('un punto de venta sin ningún cierre no genera avisos; si no hay nada que avisar, la lista está vacía', async () => {
  limpiar();
  const res = await resumen(d(-6), H);
  assert.deepEqual(res.avisos, []);
  assert.deepEqual(res.no_trabajados, []);
});

test('los días anteriores al primer cierre del punto de venta no se avisan', async () => {
  limpiar();
  await crear(1, d(-3));
  const a = avisoDe(await resumen(d(-6), H), 1);
  assert.deepEqual(a.fechas, [d(-2), d(-1)]);
});

test('un día no trabajado cuenta como cerrado y se lista con su motivo', async () => {
  limpiar();
  await crear(3, d(-6));
  await crear(3, d(-4), 'no_trabajado', { motivo: 'lluvia' });
  await crear(3, d(-2));
  const res = await resumen(d(-6), H);
  assert.deepEqual(avisoDe(res, 3).fechas, [d(-5), d(-3), d(-1)]);
  assert.deepEqual(res.no_trabajados, [{ punto_venta_id: 3, nombre: 'Chapadmalal', fecha: d(-4), tipo: 'no_trabajado', motivo: 'lluvia' }]);
});

test('los avisos solo consideran los días del rango pedido', async () => {
  limpiar();
  await crear(3, d(-6));
  await crear(3, d(-2));
  const res = await resumen(d(-2), H);
  assert.deepEqual(avisoDe(res, 3).fechas, [d(-1)]);
  // un rango que empieza antes del primer cierre
  assert.deepEqual(avisoDe(await resumen(d(-20), d(-4)), 3).fechas, [d(-5), d(-4)]);
});

test('el rango todo en el futuro o que termina antes del primer cierre no tiene avisos', async () => {
  limpiar();
  await crear(3, d(-3));
  assert.deepEqual((await resumen(d(1), d(5))).avisos, []);
  assert.deepEqual((await resumen(d(-10), d(-5))).avisos, []);
});

test('fin de temporada: los días posteriores no se avisan; al volver a cargar, vuelven a exigirse los diarios', async () => {
  limpiar();
  await crear(2, d(-9));
  const fin = await crear(2, d(-7), 'fin_temporada');
  assert.equal(fin.motivo, 'Fin de temporada');

  let res = await resumen(d(-9), H);
  assert.deepEqual(avisoDe(res, 2).fechas, [d(-8)], 'solo el día entre el último cierre y el fin de temporada');
  assert.deepEqual(res.no_trabajados.map(x => [x.fecha, x.tipo, x.motivo]), [[d(-7), 'fin_temporada', 'Fin de temporada']]);

  // temporada siguiente: se carga un cierre posterior
  await crear(2, d(-3));
  res = await resumen(d(-9), H);
  assert.deepEqual(avisoDe(res, 2).fechas, [d(-8), d(-2), d(-1)], 'los días entre el fin y el nuevo cierre no se avisan');

  // si se elimina el fin de temporada, vuelven los avisos
  await adm('/caja/cierres/' + fin.id, 'DELETE', { motivo: 'error' });
  res = await resumen(d(-9), H);
  assert.deepEqual(avisoDe(res, 2).fechas, [d(-8), d(-7), d(-6), d(-5), d(-4), d(-2), d(-1)]);
  assert.deepEqual(res.no_trabajados, []);
});

test('el fin de temporada de un punto de venta no afecta a los otros', async () => {
  limpiar();
  await crear(1, d(-6));
  await crear(2, d(-6));
  await crear(2, d(-5), 'fin_temporada');
  const res = await resumen(d(-6), H);
  assert.equal(avisoDe(res, 2), undefined);
  assert.deepEqual(avisoDe(res, 1).fechas, [d(-5), d(-4), d(-3), d(-2), d(-1)]);
});

test('un cierre eliminado no cuenta como cierre', async () => {
  limpiar();
  await crear(3, d(-4));
  const medio = await crear(3, d(-3));
  await crear(3, d(-2));
  assert.deepEqual(avisoDe(await resumen(d(-4), H), 3).fechas, [d(-1)]);
  await adm('/caja/cierres/' + medio.id, 'DELETE', { motivo: 'error' });
  assert.deepEqual(avisoDe(await resumen(d(-4), H), 3).fechas, [d(-3), d(-1)]);
});

test('los días no trabajados se listan ordenados por fecha y solo los del rango', async () => {
  limpiar();
  await crear(2, d(-5), 'no_trabajado', { motivo: 'feriado' });
  await crear(1, d(-5), 'no_trabajado', { motivo: 'lluvia' });
  await crear(3, d(-8), 'no_trabajado', { motivo: 'fuera del rango' });
  await crear(1, d(-4));
  const res = await resumen(d(-6), H);
  assert.deepEqual(res.no_trabajados.map(x => [x.fecha, x.punto_venta_id, x.motivo]), [[d(-5), 1, 'lluvia'], [d(-5), 2, 'feriado']]);
});

test('un punto de venta inactivo no genera avisos', async () => {
  limpiar();
  await crear(1, d(-4));
  assert.ok(avisoDe(await resumen(d(-4), H), 1));
  db.prepare('UPDATE puntos_venta SET activo = 0 WHERE id = 1').run();
  assert.equal(avisoDe(await resumen(d(-4), H), 1), undefined);
  db.prepare('UPDATE puntos_venta SET activo = 1 WHERE id = 1').run();
});

test('los avisos y los días no trabajados también vienen con las agrupaciones por día, semana y mes', async () => {
  limpiar();
  await crear(3, d(-6));
  await crear(3, d(-4), 'no_trabajado', { motivo: 'lluvia' });
  for (const agrupar of ['total', 'dia', 'semana', 'mes']) {
    const res = await resumen(d(-6), H, agrupar);
    assert.deepEqual(avisoDe(res, 3).fechas, [d(-5), d(-3), d(-2), d(-1)], agrupar);
    assert.equal(res.no_trabajados.length, 1, agrupar);
  }
});

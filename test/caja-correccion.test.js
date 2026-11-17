// T5 · Corregir y borrar cierres de caja (spec 9.3 RN-C4, 9.5 y criterios de 9.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-correccion-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { ahoraLocal, sumarDias } = require('../src/reglas');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
test.after(() => { server.close(); });

const hoy = ahoraLocal().fecha;
const cfgBase = { precio_balde: 1000, umbral_baldes: 10, descuento_pct: 15, hora_corte: '12:00', email_propietario: 'dueno@example.com' };
const precios = (efectivo, transferencia, desde) => adm('/config', 'PUT', { ...cfgBase, precio_bowl_efectivo: efectivo, precio_bowl_transferencia: transferencia, precio_bowl_desde: desde });
const crear = async (body) => { const r = await adm('/caja/cierres', 'POST', body); assert.equal(r.status, 201, JSON.stringify(await r.clone().json())); return r.json(); };
const corregir = (id, body) => adm('/caja/cierres/' + id, 'PUT', body);
const eliminar = (id, body) => adm('/caja/cierres/' + id, 'DELETE', body);
test.before(async () => {
  await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  await precios(4000, 4500, '2020-01-01');
});

const leer = id => ({ ...db.prepare('SELECT * FROM cierres_caja WHERE id = ?').get(id) });

// Día trabajado del spec: 5.000 + 20.000 − 3.000 = 22.000 esperados.
const ejemplo = (fecha, over = {}) => ({
  punto_venta_id: 1, fecha, tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 5, bowls_transferencia: 2, gastos: 3000, efectivo_contado: 22000, ...over,
});

test('corregir un monto: se recalculan ingresos, esperado y diferencia, y se completa corregido_en', async () => {
  const c = await crear(ejemplo('2025-11-02'));
  assert.equal(c.corregido_en, null);
  const r = await corregir(c.id, ejemplo('2025-11-02', { efectivo_contado: 21500, nota_diferencia: 'faltó un vuelto' }));
  assert.equal(r.status, 200);
  const n = await r.json();
  assert.equal(n.id, c.id);
  assert.equal(n.diferencia, -500);
  assert.equal(n.efectivo_esperado, 22000);
  assert.equal(n.nota_diferencia, 'faltó un vuelto');
  assert.match(n.corregido_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(n.creado_en, c.creado_en, 'la fecha de alta no cambia');
  // el listado ya muestra los valores nuevos
  const lista = await (await adm('/caja/cierres?desde=2025-11-02&hasta=2025-11-02')).json();
  assert.equal(lista[0].diferencia, -500);
  // y se puede corregir de nuevo
  const r2 = await corregir(c.id, ejemplo('2025-11-02'));
  assert.equal((await r2.json()).diferencia, 0);
});

test('corregir cantidades recalcula con los precios que el cierre ya tenía, aunque hayan cambiado', async () => {
  const c = await crear(ejemplo('2025-11-03', { efectivo_contado: 22000 }));
  await precios(9000, 9500, '2025-11-01'); // cambia el precio vigente en esa fecha
  const r = await corregir(c.id, ejemplo('2025-11-03', { bowls_efectivo: 6, bowls_transferencia: 3, efectivo_contado: 26000 }));
  assert.equal(r.status, 200);
  const n = await r.json();
  assert.equal(n.precio_bowl_efectivo, 4000);
  assert.equal(n.ingresos_efectivo, 24000);
  assert.equal(n.ingresos_transferencia, 13500);
  assert.equal(n.efectivo_esperado, 26000);
  assert.equal(n.diferencia, 0);
  // vuelve el precio de antes para no condicionar los demás tests
  db.prepare("DELETE FROM precios_bowl WHERE vigente_desde = '2025-11-01'").run();
});

test('corregir la fecha toma los precios vigentes en la fecha nueva', async () => {
  await precios(5000, 5500, '2025-11-15');
  const c = await crear({ punto_venta_id: 1, fecha: '2025-11-12', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 1, bowls_transferencia: 1, gastos: 0, efectivo_contado: 4000 });
  assert.equal(c.precio_bowl_efectivo, 4000);
  const r = await corregir(c.id, { punto_venta_id: 1, fecha: '2025-11-16', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 1, bowls_transferencia: 1, gastos: 0, efectivo_contado: 5000 });
  assert.equal(r.status, 200);
  const n = await r.json();
  assert.equal(n.fecha, '2025-11-16');
  assert.equal(n.precio_bowl_efectivo, 5000);
  assert.equal(n.ingresos_transferencia, 5500);
});

test('corregir la fecha a un día sin precio vigente responde 409 y no cambia nada', async () => {
  const c = await crear(ejemplo('2025-11-04'));
  const antes = leer(c.id);
  const r = await corregir(c.id, ejemplo('2019-12-31'));
  assert.equal(r.status, 409);
  assert.match((await r.json()).errores.join(' '), /precio del bowl/i);
  assert.deepEqual(leer(c.id), antes);
});

test('corregir sin explicar una diferencia responde 400 y no cambia nada', async () => {
  const c = await crear(ejemplo('2025-11-05'));
  const antes = leer(c.id);
  const r = await corregir(c.id, ejemplo('2025-11-05', { efectivo_contado: 100 }));
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errores.some(e => /nota/i.test(e)));
  assert.deepEqual(leer(c.id), antes);
});

test('corregir con valores inválidos responde 400 y no cambia nada', async () => {
  const c = await crear(ejemplo('2025-11-06'));
  const antes = leer(c.id);
  for (const over of [{ fondo_inicial: -1 }, { bowls_efectivo: 1.5 }, { fecha: sumarDias(hoy, 1) }, { tipo: 'otro' }, { fecha: '2025-02-30' }]) {
    const r = await corregir(c.id, ejemplo('2025-11-06', over));
    assert.equal(r.status, 400, JSON.stringify(over));
  }
  assert.deepEqual(leer(c.id), antes);
});

test('se puede cambiar el tipo: trabajado → no trabajado (montos en cero) y de vuelta a trabajado', async () => {
  const c = await crear(ejemplo('2025-11-07'));
  let r = await corregir(c.id, { punto_venta_id: 1, fecha: '2025-11-07', tipo: 'no_trabajado', motivo: 'lluvia' });
  assert.equal(r.status, 200);
  let n = await r.json();
  assert.equal(n.tipo, 'no_trabajado');
  assert.equal(n.motivo, 'lluvia');
  for (const k of ['fondo_inicial', 'bowls_efectivo', 'ingresos_efectivo', 'ingresos_transferencia', 'gastos', 'efectivo_esperado', 'efectivo_contado', 'diferencia', 'ventas', 'utilidad_relativa']) assert.equal(n[k], 0, k);
  assert.equal(n.precio_bowl_efectivo, null);

  // sin motivo, un no trabajado no se acepta
  r = await corregir(c.id, { punto_venta_id: 1, fecha: '2025-11-07', tipo: 'no_trabajado', motivo: '' });
  assert.equal(r.status, 400);

  // de vuelta a trabajado: toma el precio vigente en esa fecha
  r = await corregir(c.id, ejemplo('2025-11-07'));
  assert.equal(r.status, 200);
  n = await r.json();
  assert.equal(n.tipo, 'trabajado');
  assert.equal(n.motivo, '');
  assert.equal(n.precio_bowl_efectivo, 4000);
  assert.equal(n.ventas, 29000);

  // a fin de temporada, sin motivo
  r = await corregir(c.id, { punto_venta_id: 1, fecha: '2025-11-07', tipo: 'fin_temporada' });
  assert.equal((await r.json()).motivo, 'Fin de temporada');
});

test('unicidad al corregir: no se puede pisar el cierre de otro día/punto; el propio punto y fecha no cuenta como conflicto', async () => {
  const a = await crear(ejemplo('2025-11-08'));
  const b = await crear(ejemplo('2025-11-09'));
  // b → fecha de a: conflicto
  let r = await corregir(b.id, ejemplo('2025-11-08'));
  assert.equal(r.status, 409);
  assert.match((await r.json()).errores.join(' '), /ya hay un cierre/i);
  assert.equal(leer(b.id).fecha, '2025-11-09');
  // mismo punto y fecha que el propio cierre: no es conflicto
  r = await corregir(a.id, ejemplo('2025-11-08', { gastos: 2000, efectivo_contado: 23000 }));
  assert.equal(r.status, 200);
  // b → otro punto de venta en la fecha de a: se acepta
  r = await corregir(b.id, ejemplo('2025-11-08', { punto_venta_id: 2 }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).punto_venta, 'Miramar 2');
  // un cierre eliminado no bloquea
  db.prepare("UPDATE cierres_caja SET eliminado_en = '2025-11-20 10:00', motivo_eliminacion = 'x' WHERE id = ?").run(a.id);
  r = await corregir(b.id, ejemplo('2025-11-08', { punto_venta_id: 1 }));
  assert.equal(r.status, 200);
});

test('corregir: punto de venta inexistente o inactivo responde 404', async () => {
  const c = await crear(ejemplo('2025-11-10'));
  assert.equal((await corregir(c.id, ejemplo('2025-11-10', { punto_venta_id: 99 }))).status, 404);
  db.prepare('UPDATE puntos_venta SET activo = 0 WHERE id = 3').run();
  assert.equal((await corregir(c.id, ejemplo('2025-11-10', { punto_venta_id: 3 }))).status, 404);
  db.prepare('UPDATE puntos_venta SET activo = 1 WHERE id = 3').run();
});

test('corregir un cierre que no existe, que está eliminado o con un id inválido responde 404', async () => {
  assert.equal((await corregir(9999, ejemplo('2025-11-11'))).status, 404);
  assert.equal((await corregir('abc', ejemplo('2025-11-11'))).status, 404);
  const c = await crear(ejemplo('2025-11-11'));
  await eliminar(c.id, { motivo: 'error' });
  assert.equal((await corregir(c.id, ejemplo('2025-11-11'))).status, 404);
});

test('eliminar exige motivo: sin motivo o en blanco responde 400 y el cierre sigue activo', async () => {
  const c = await crear(ejemplo('2025-11-12'));
  for (const body of [undefined, {}, { motivo: '' }, { motivo: '   ' }]) {
    const r = await eliminar(c.id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok((await r.json()).errores.some(e => /motivo/i.test(e)));
  }
  assert.equal(leer(c.id).eliminado_en, null);
});

test('eliminar con motivo: borrado lógico, sale de los listados normales y libera la fecha', async () => {
  const c = await crear(ejemplo('2025-11-13'));
  const r = await eliminar(c.id, { motivo: 'lo cargué dos veces' });
  assert.equal(r.status, 200);
  const n = await r.json();
  assert.equal(n.id, c.id);
  assert.match(n.eliminado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(n.motivo_eliminacion, 'lo cargué dos veces');

  const fila = leer(c.id);
  assert.ok(fila.eliminado_en, 'el registro sigue en la base (borrado lógico)');

  const activos = await (await adm('/caja/cierres?desde=2025-11-13&hasta=2025-11-13')).json();
  assert.equal(activos.length, 0);
  const solo = await (await adm('/caja/cierres?desde=2025-11-13&hasta=2025-11-13&eliminados=solo')).json();
  assert.equal(solo.length, 1);
  assert.equal(solo[0].motivo_eliminacion, 'lo cargué dos veces');

  // la fecha quedó libre para cargar uno nuevo
  const nuevo = await adm('/caja/cierres', 'POST', ejemplo('2025-11-13'));
  assert.equal(nuevo.status, 201);
});

test('eliminar un cierre que no existe o ya está eliminado responde 404', async () => {
  const c = await crear(ejemplo('2025-11-14'));
  assert.equal((await eliminar(c.id, { motivo: 'x' })).status, 200);
  assert.equal((await eliminar(c.id, { motivo: 'x' })).status, 404);
  assert.equal((await eliminar(9999, { motivo: 'x' })).status, 404);
  assert.equal((await eliminar('abc', { motivo: 'x' })).status, 404);
});

test('corregir y eliminar requieren autenticación', async () => {
  const c = await crear(ejemplo('2025-11-17', { efectivo_contado: 27000 })); // ese día rige el precio de $5.000: 5.000 + 25.000 − 3.000
  const sin = (method) => fetch(base + '/api/admin/caja/cierres/' + c.id, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await sin('PUT')).status, 401);
  assert.equal((await sin('DELETE')).status, 401);
});

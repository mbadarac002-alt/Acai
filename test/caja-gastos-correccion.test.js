// T7 · Corregir y borrar gastos generales (spec 9.3 RN-C5, 9.5 y criterios de 9.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-gastos-corr-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { ahoraLocal, sumarDias } = require('../src/reglas');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });

const hoy = ahoraLocal().fecha;
const crear = async (over = {}) => {
  const r = await adm('/caja/gastos', 'POST', { fecha: '2025-11-10', monto: 50000, categoria_id: 1, nota: 'baldes', ...over });
  assert.equal(r.status, 201);
  return r.json();
};
const corregir = (id, body) => adm('/caja/gastos/' + id, 'PUT', body);
const eliminar = (id, body) => adm('/caja/gastos/' + id, 'DELETE', body);
const leer = id => ({ ...db.prepare('SELECT * FROM gastos_generales WHERE id = ?').get(id) });

test('corregir un gasto: cambia monto, fecha, categoría y nota, y completa corregido_en', async () => {
  const g = await crear();
  assert.equal(g.corregido_en, null);
  const r = await corregir(g.id, { fecha: '2025-11-12', monto: 45000.5, categoria_id: 3, nota: 'afiches' });
  assert.equal(r.status, 200);
  const n = await r.json();
  assert.equal(n.id, g.id);
  assert.equal(n.fecha, '2025-11-12');
  assert.equal(n.monto, 45000.5);
  assert.equal(n.categoria, 'publicidad');
  assert.equal(n.tipo, 'corriente');
  assert.equal(n.nota, 'afiches');
  assert.match(n.corregido_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(n.creado_en, g.creado_en, 'la fecha de alta no cambia');
  assert.equal(leer(g.id).monto, 4500050, 'en centavos');
  // el listado muestra los valores nuevos
  const lista = await (await adm('/caja/gastos?desde=2025-11-12&hasta=2025-11-12')).json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].categoria, 'publicidad');
});

test('corregir con datos inválidos responde 400 y no cambia nada', async () => {
  const g = await crear({ fecha: '2025-11-11' });
  const antes = leer(g.id);
  const ok = { fecha: '2025-11-11', monto: 100, categoria_id: 1 };
  for (const over of [{ monto: 0 }, { monto: -1 }, { monto: 'x' }, { categoria_id: 999 }, { fecha: sumarDias(hoy, 1) }, { fecha: '2025-02-30' }]) {
    const r = await corregir(g.id, { ...ok, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
  }
  assert.deepEqual(leer(g.id), antes);
});

test('corregir un gasto que no existe, que está eliminado o con un id inválido responde 404', async () => {
  const body = { fecha: '2025-11-10', monto: 100, categoria_id: 1 };
  assert.equal((await corregir(9999, body)).status, 404);
  assert.equal((await corregir('abc', body)).status, 404);
  const g = await crear({ fecha: '2025-11-13' });
  await eliminar(g.id, { motivo: 'error' });
  assert.equal((await corregir(g.id, body)).status, 404);
});

test('eliminar exige motivo: sin motivo o en blanco responde 400 y el gasto sigue activo', async () => {
  const g = await crear({ fecha: '2025-11-14' });
  for (const body of [undefined, {}, { motivo: '' }, { motivo: '   ' }]) {
    const r = await eliminar(g.id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok((await r.json()).errores.some(e => /motivo/i.test(e)));
  }
  assert.equal(leer(g.id).eliminado_en, null);
});

test('eliminar con motivo: borrado lógico, sale de los listados normales y se ve con el filtro', async () => {
  const g = await crear({ fecha: '2025-11-15' });
  const r = await eliminar(g.id, { motivo: 'lo cargué dos veces' });
  assert.equal(r.status, 200);
  const n = await r.json();
  assert.equal(n.id, g.id);
  assert.match(n.eliminado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(n.motivo_eliminacion, 'lo cargué dos veces');
  assert.ok(leer(g.id).eliminado_en, 'el registro sigue en la base');

  const activos = await (await adm('/caja/gastos?desde=2025-11-15&hasta=2025-11-15')).json();
  assert.equal(activos.length, 0);
  const solo = await (await adm('/caja/gastos?desde=2025-11-15&hasta=2025-11-15&eliminados=solo')).json();
  assert.equal(solo.length, 1);
  assert.equal(solo[0].motivo_eliminacion, 'lo cargué dos veces');
});

test('eliminar un gasto que no existe o ya está eliminado responde 404', async () => {
  const g = await crear({ fecha: '2025-11-16' });
  assert.equal((await eliminar(g.id, { motivo: 'x' })).status, 200);
  assert.equal((await eliminar(g.id, { motivo: 'x' })).status, 404);
  assert.equal((await eliminar(9999, { motivo: 'x' })).status, 404);
  assert.equal((await eliminar('abc', { motivo: 'x' })).status, 404);
});

test('corregir y eliminar gastos requieren autenticación', async () => {
  const g = await crear({ fecha: '2025-11-17' });
  const sin = method => fetch(base + '/api/admin/caja/gastos/' + g.id, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await sin('PUT')).status, 401);
  assert.equal((await sin('DELETE')).status, 401);
});

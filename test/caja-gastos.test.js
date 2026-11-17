// T6 · Crear y listar gastos generales (spec 9.3 RN-C5, 9.5 y criterios de 9.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-gastos-'));
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
const crear = (body) => adm('/caja/gastos', 'POST', body);
const contar = () => db.prepare('SELECT COUNT(*) n FROM gastos_generales').get().n;
let cats;
const cat = nombre => cats.find(c => c.nombre === nombre).id;

test('categorías: las 7 iniciales con su tipo', async () => {
  cats = await (await adm('/caja/categorias')).json();
  assert.deepEqual(Object.fromEntries(cats.map(c => [c.nombre, c.tipo])), {
    'mercadería': 'stock', 'envases y descartables': 'stock', 'publicidad': 'corriente', 'transporte': 'corriente',
    'servicios y alquileres': 'corriente', 'sueldos': 'corriente', 'otros': 'corriente',
  });
});

test('crear un gasto: $50.000 de mercadería fechado el 28/11 (stock)', async () => {
  const r = await crear({ fecha: '2025-11-28', monto: 50000, categoria_id: cat('mercadería'), nota: '10 baldes de açaí' });
  assert.equal(r.status, 201);
  const g = await r.json();
  assert.equal(g.fecha, '2025-11-28');
  assert.equal(g.monto, 50000);
  assert.equal(g.categoria, 'mercadería');
  assert.equal(g.tipo, 'stock');
  assert.equal(g.nota, '10 baldes de açaí');
  assert.equal(g.corregido_en, null);
  assert.equal(g.eliminado_en, null);
  assert.match(g.creado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(db.prepare('SELECT monto FROM gastos_generales WHERE id = ?').get(g.id).monto, 5000000, 'se guarda en centavos');
});

test('un gasto de publicidad es corriente; la nota es opcional', async () => {
  const g = await (await crear({ fecha: '2025-11-20', monto: 1234.56, categoria_id: cat('publicidad') })).json();
  assert.equal(g.tipo, 'corriente');
  assert.equal(g.nota, '');
  assert.equal(g.monto, 1234.56);
  assert.equal(db.prepare('SELECT monto FROM gastos_generales WHERE id = ?').get(g.id).monto, 123456);
});

test('un gasto de hoy es válido', async () => {
  assert.equal((await crear({ fecha: hoy, monto: 100, categoria_id: cat('otros') })).status, 201);
});

test('validaciones: monto > 0, categoría existente, fecha válida y no futura (400) y no se guarda nada', async () => {
  const antes = contar();
  const ok = { fecha: '2025-11-21', monto: 100, categoria_id: 1 };
  const casos = [
    [{ ...ok, monto: 0 }, /monto/i],
    [{ ...ok, monto: -5 }, /monto/i],
    [{ ...ok, monto: 'abc' }, /monto/i],
    [{ ...ok, monto: '' }, /monto/i],
    [{ ...ok, monto: 0.001 }, /monto/i],
    [{ ...ok, monto: 5000000000 }, /monto/i],
    [{ ...ok, monto: undefined }, /monto/i],
    [{ ...ok, categoria_id: 999 }, /categor/i],
    [{ ...ok, categoria_id: 'abc' }, /categor/i],
    [{ ...ok, categoria_id: undefined }, /categor/i],
    [{ ...ok, fecha: sumarDias(hoy, 1) }, /futura/i],
    [{ ...ok, fecha: '2025-02-30' }, /inválida/i],
    [{ ...ok, fecha: undefined }, /inválida/i],
  ];
  for (const [body, patron] of casos) {
    const r = await crear(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const { errores } = await r.json();
    assert.ok(errores.some(e => patron.test(e)), `${JSON.stringify(body)} -> ${errores}`);
  }
  assert.equal(contar(), antes);
});

test('listado: orden por fecha descendente y filtros por rango y categoría', async () => {
  await crear({ fecha: '2025-12-02', monto: 300, categoria_id: cat('transporte'), nota: 'nafta' });
  await crear({ fecha: '2025-12-05', monto: 400, categoria_id: cat('transporte') });
  const todos = await (await adm('/caja/gastos')).json();
  const fechas = todos.map(g => g.fecha);
  assert.deepEqual(fechas, [...fechas].sort().reverse());

  let l = await (await adm('/caja/gastos?desde=2025-12-01&hasta=2025-12-31')).json();
  assert.deepEqual(l.map(g => g.fecha), ['2025-12-05', '2025-12-02']);
  l = await (await adm(`/caja/gastos?categoria_id=${cat('transporte')}`)).json();
  assert.ok(l.length === 2 && l.every(g => g.categoria === 'transporte'));
  l = await (await adm('/caja/gastos?desde=2025-12-05')).json();
  assert.ok(l.every(g => g.fecha >= '2025-12-05'));
});

test('listado: los eliminados no se ven salvo con el filtro', async () => {
  const g = await (await crear({ fecha: '2025-12-10', monto: 999, categoria_id: cat('sueldos') })).json();
  db.prepare("UPDATE gastos_generales SET eliminado_en = '2025-12-11 09:00', motivo_eliminacion = 'duplicado' WHERE id = ?").run(g.id);
  const activos = await (await adm('/caja/gastos')).json();
  assert.ok(!activos.some(x => x.id === g.id));
  const solo = await (await adm('/caja/gastos?eliminados=solo')).json();
  assert.ok(solo.length >= 1 && solo.every(x => x.eliminado_en));
  assert.equal(solo.find(x => x.id === g.id).motivo_eliminacion, 'duplicado');
  const todos = await (await adm('/caja/gastos?eliminados=todos')).json();
  assert.equal(todos.length, activos.length + solo.length);
});

test('listado: filtros inválidos responden 400', async () => {
  for (const q of ['eliminados=x', 'desde=2025-13-01', 'desde=2025-12-10&hasta=2025-12-01', 'categoria_id=abc']) {
    assert.equal((await adm('/caja/gastos?' + q)).status, 400, q);
  }
});

test('categorías y gastos requieren autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/caja/categorias')).status, 401);
  assert.equal((await fetch(base + '/api/admin/caja/gastos')).status, 401);
  const r = await fetch(base + '/api/admin/caja/gastos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

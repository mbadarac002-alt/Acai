// T3 · Precios del bowl con vigencia por fecha (spec 9.3 RN-C2 y 9.5).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-precios-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { ahoraLocal } = require('../src/reglas');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });

const hoy = ahoraLocal().fecha;
// Lo que manda hoy el panel de configuración, sin los precios del bowl.
const cfgBase = { precio_balde: 1000, umbral_baldes: 10, descuento_pct: 15, hora_corte: '12:00', email_propietario: 'dueno@example.com' };
const guardar = (extra = {}) => adm('/config', 'PUT', { ...cfgBase, ...extra });
const historial = async () => (await adm('/caja/precios')).json();
const config = async () => (await adm('/config')).json();

test('sin precios cargados, la configuración los devuelve vacíos y el historial está vacío', async () => {
  const c = await config();
  assert.equal(c.precio_bowl_efectivo, null);
  assert.equal(c.precio_bowl_transferencia, null);
  assert.equal(c.precio_bowl_vigente_desde, null);
  assert.deepEqual(await historial(), []);
});

test('guardar la configuración sin precios del bowl sigue funcionando y no toca el historial', async () => {
  assert.equal((await guardar()).status, 200);
  // el panel manda los campos vacíos cuando todavía no hay precios
  assert.equal((await guardar({ precio_bowl_efectivo: '', precio_bowl_transferencia: '', precio_bowl_desde: '' })).status, 200);
  assert.deepEqual(await historial(), []);
  assert.equal((await config()).precio_balde, 1000);
});

test('un cambio de precios con fecha de vigencia se agrega al historial y la configuración devuelve el vigente hoy', async () => {
  const r = await guardar({ precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2020-01-01' });
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.precio_bowl_efectivo, 4000);
  assert.equal(c.precio_bowl_transferencia, 4500);
  assert.equal(c.precio_bowl_vigente_desde, '2020-01-01');
  const h = await historial();
  assert.equal(h.length, 1);
  assert.equal(h[0].vigente_desde, '2020-01-01');
  assert.equal(h[0].precio_efectivo, 4000);
  assert.equal(h[0].precio_transferencia, 4500);
  assert.match(h[0].creado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('los precios se guardan en centavos enteros y se devuelven en pesos', async () => {
  await guardar({ precio_bowl_efectivo: '4000.50', precio_bowl_transferencia: '4500.25', precio_bowl_desde: '2020-03-01' });
  const fila = db.prepare("SELECT precio_efectivo, precio_transferencia FROM precios_bowl WHERE vigente_desde = '2020-03-01'").get();
  assert.deepEqual({ ...fila }, { precio_efectivo: 400050, precio_transferencia: 450025 });
  assert.equal((await config()).precio_bowl_efectivo, 4000.5);
});

test('un cambio nuevo no borra los anteriores; el historial va del más reciente al más antiguo', async () => {
  await guardar({ precio_bowl_efectivo: 5000, precio_bowl_transferencia: 5500, precio_bowl_desde: '2020-06-01' });
  const h = await historial();
  assert.deepEqual(h.map(x => x.vigente_desde), ['2020-06-01', '2020-03-01', '2020-01-01']);
  assert.equal(h[2].precio_efectivo, 4000); // el primero quedó intacto
  assert.equal((await config()).precio_bowl_efectivo, 5000);
});

test('otro cambio con la misma fecha de vigencia reemplaza al anterior (corrección de un error de carga)', async () => {
  await guardar({ precio_bowl_efectivo: 5100, precio_bowl_transferencia: 5600, precio_bowl_desde: '2020-06-01' });
  const h = await historial();
  assert.equal(h.length, 3);
  assert.equal(h[0].precio_efectivo, 5100);
});

test('reenviar los mismos precios (como hace el panel al guardar otra cosa) no agrega filas', async () => {
  const antes = (await historial()).length;
  // sin fecha: rige desde hoy, pero los precios ya son los vigentes
  assert.equal((await guardar({ precio_bowl_efectivo: 5100, precio_bowl_transferencia: 5600, precio_bowl_desde: '' })).status, 200);
  assert.equal((await historial()).length, antes);
  assert.equal((await guardar({ precio_bowl_efectivo: 5100, precio_bowl_transferencia: 5600 })).status, 200);
  assert.equal((await historial()).length, antes);
});

test('sin fecha de vigencia, los precios nuevos rigen desde hoy', async () => {
  await guardar({ precio_bowl_efectivo: 7000, precio_bowl_transferencia: 7500 });
  const h = await historial();
  assert.equal(h[0].vigente_desde, hoy);
  assert.equal((await config()).precio_bowl_vigente_desde, hoy);
});

test('un precio con vigencia futura queda en el historial pero no es el vigente hoy', async () => {
  await guardar({ precio_bowl_efectivo: 9000, precio_bowl_transferencia: 9500, precio_bowl_desde: '2999-01-01' });
  const h = await historial();
  assert.equal(h[0].vigente_desde, '2999-01-01');
  const c = await config();
  assert.equal(c.precio_bowl_efectivo, 7000);
  assert.equal(c.precio_bowl_vigente_desde, hoy);
});

test('validaciones: precios positivos, los dos juntos y fecha válida (400 con mensajes)', async () => {
  const antes = (await historial()).length;
  const casos = [
    [{ precio_bowl_efectivo: 4000 }, /los dos precios/i],
    [{ precio_bowl_transferencia: 4000 }, /los dos precios/i],
    [{ precio_bowl_efectivo: 0, precio_bowl_transferencia: 4500 }, /efectivo.*mayor a 0/i],
    [{ precio_bowl_efectivo: 4000, precio_bowl_transferencia: -1 }, /transferencia.*mayor a 0/i],
    [{ precio_bowl_efectivo: 'abc', precio_bowl_transferencia: 4500 }, /efectivo.*mayor a 0/i],
    [{ precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2026-02-30' }, /fecha/i],
    [{ precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '01/11/2026' }, /fecha/i],
  ];
  for (const [extra, patron] of casos) {
    const r = await guardar(extra);
    assert.equal(r.status, 400, JSON.stringify(extra));
    const { errores } = await r.json();
    assert.ok(errores.some(e => patron.test(e)), `${JSON.stringify(extra)} -> ${errores}`);
  }
  assert.equal((await historial()).length, antes, 'una carga inválida no guarda nada');
});

test('un error en otro campo de la configuración no guarda los precios', async () => {
  const antes = (await historial()).length;
  const r = await guardar({ hora_corte: 'mal', precio_bowl_efectivo: 1234, precio_bowl_transferencia: 1300, precio_bowl_desde: '2020-08-01' });
  assert.equal(r.status, 400);
  assert.equal((await historial()).length, antes);
});

test('el historial de precios requiere autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/caja/precios')).status, 401);
});

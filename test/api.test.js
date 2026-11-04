const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { ahoraLocal } = require('../src/reglas');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });

test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });

const cliente = { nombre: 'Ana Pérez', dni: '30123456', direccion: 'Av. Siempre Viva 742', telefono: '11 5555-1234' };

test('flujo completo: alta de cliente, pedido, descuento, estados y mail', async () => {
  const hoy = ahoraLocal().fecha;
  let r = await adm('/config', 'PUT', { precio_balde: 1000, umbral_baldes: 10, descuento_pct: 15, rango_desde: '2000-01-01', rango_hasta: '2100-12-31', hora_corte: '12:00', email_propietario: 'dueno@example.com' });
  assert.equal(r.status, 200);

  r = await post('/api/pedidos', { ...cliente, cantidad: 6 });
  assert.equal(r.status, 201);
  const p1 = await r.json();
  assert.equal(p1.cliente_nuevo, true);
  assert.equal(p1.total, 6000);
  assert.equal(p1.descuento_pct, 0);
  assert.ok(p1.fecha_entrega >= hoy);
  assert.equal(new Date(p1.fecha_entrega + 'T12:00:00Z').getUTCDay(), 5, 'la entrega es un viernes');

  // Segundo pedido: acumula 10 -> alcanza el umbral, descuento sobre todo el pedido
  r = await post('/api/pedidos', { ...cliente, cantidad: 4 });
  const p2 = await r.json();
  assert.equal(p2.cliente_nuevo, false);
  assert.equal(p2.baldes_acumulados, 10);
  assert.equal(p2.descuento_pct, 15);
  assert.equal(p2.total, 3400);

  // Un cambio de precio no altera pedidos ya registrados
  await adm('/config', 'PUT', { precio_balde: 2000, umbral_baldes: 10, descuento_pct: 15, rango_desde: '2000-01-01', rango_hasta: '2100-12-31', hora_corte: '12:00', email_propietario: 'dueno@example.com' });
  const pedidos = await (await adm('/pedidos')).json();
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos.find(p => p.id === p1.pedido_id).total, 6000);

  const clientes = await (await adm('/clientes')).json();
  assert.equal(clientes.length, 1);
  assert.equal(clientes[0].baldes_totales, 10);

  // Estados
  r = await adm('/pedidos/' + p1.pedido_id, 'PATCH', { estado: 'en_proceso' });
  assert.equal(r.status, 200);
  r = await adm('/pedidos/' + p1.pedido_id, 'PATCH', { estado: 'cancelado' });
  assert.equal(r.status, 400);
  const enProceso = await (await adm('/pedidos?estado=en_proceso')).json();
  assert.deepEqual(enProceso.map(p => p.id), [p1.pedido_id]);

  // Mail al propietario (sin SMTP queda en data/outbox)
  const outbox = path.join(__dirname, '..', 'data', 'outbox');
  assert.ok(fs.readdirSync(outbox).length >= 2);
});

test('validaciones del formulario', async () => {
  const r = await post('/api/pedidos', { nombre: '', dni: 'abc', direccion: '', telefono: '1', cantidad: 0 });
  assert.equal(r.status, 400);
  const { errores } = await r.json();
  assert.equal(errores.length, 5);
});

test('el panel requiere autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/pedidos')).status, 401);
  assert.equal((await fetch(base + '/admin')).status, 401);
});

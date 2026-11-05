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
  let r = await adm('/config', 'PUT', { precio_balde: 1000, umbral_baldes: 10, descuento_pct: 15, hora_corte: '12:00', email_propietario: 'dueno@example.com' });
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
  await adm('/config', 'PUT', { precio_balde: 2000, umbral_baldes: 10, descuento_pct: 15, hora_corte: '12:00', email_propietario: 'dueno@example.com' });
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
  const outbox = path.join(tmp, 'outbox');
  assert.ok(fs.readdirSync(outbox).length >= 2);
});

test('validaciones del formulario', async () => {
  const r = await post('/api/pedidos', { nombre: '', dni: 'abc', direccion: '', telefono: '1', cantidad: 0 });
  assert.equal(r.status, 400);
  const { errores } = await r.json();
  assert.equal(errores.length, 5);
});

test('cantidad de baldes: mayor a 0 y hasta 50', async () => {
  const otro = { nombre: 'Luis Gómez', dni: '28999888', direccion: 'Calle 1', telefono: '11 4444-0000' };
  for (const cantidad of [0, -1, 51, 1.5]) {
    const r = await post('/api/pedidos', { ...otro, cantidad });
    assert.equal(r.status, 400, `cantidad ${cantidad} debe rechazarse`);
  }
  assert.equal((await post('/api/pedidos', { ...otro, cantidad: 50 })).status, 201);
  assert.equal((await post('/api/pedidos', { ...otro, cantidad: 1 })).status, 201);
});

test('historial del cliente por DNI con filtro de fechas', async () => {
  const hoy = ahoraLocal().fecha;
  let r = await fetch(`${base}/api/mis-pedidos?dni=${cliente.dni}`);
  assert.equal(r.status, 200);
  const todos = await r.json();
  assert.equal(todos.length, 2);
  assert.ok(!('dni' in todos[0]) && !('direccion' in todos[0]), 'no expone datos personales');

  // Solo ve sus propios pedidos
  const ajeno = await (await fetch(`${base}/api/mis-pedidos?dni=28999888`)).json();
  assert.equal(ajeno.length, 2);
  assert.ok(ajeno.every(p => !todos.some(t => t.id === p.id)));

  // Filtros por fecha (inclusivos)
  assert.equal((await (await fetch(`${base}/api/mis-pedidos?dni=${cliente.dni}&desde=${hoy}&hasta=${hoy}`)).json()).length, 2);
  assert.equal((await (await fetch(`${base}/api/mis-pedidos?dni=${cliente.dni}&hasta=2000-01-01`)).json()).length, 0);
  assert.equal((await (await fetch(`${base}/api/mis-pedidos?dni=${cliente.dni}&desde=2100-01-01`)).json()).length, 0);

  // Validaciones
  assert.equal((await fetch(`${base}/api/mis-pedidos?dni=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/mis-pedidos?dni=${cliente.dni}&desde=2026-12-01&hasta=2026-11-01`)).status, 400);
  assert.equal((await fetch(`${base}/api/mis-pedidos?dni=${cliente.dni}&desde=hoy`)).status, 400);
  assert.deepEqual(await (await fetch(`${base}/api/mis-pedidos?dni=11111111`)).json(), []);
});

test('panel: filtros de pedidos', async () => {
  const hoy = ahoraLocal().fecha;
  const ids = async qs => (await (await adm('/pedidos' + qs)).json()).map(p => p.id);
  const todos = await ids('');
  assert.equal(todos.length, 4);

  assert.equal((await ids('?dni=30123456')).length, 2);
  assert.equal((await ids('?dni=3012')).length, 2, 'DNI parcial');
  assert.equal((await ids('?nombre=g%C3%B3mez')).length, 2, 'nombre parcial');
  assert.equal((await ids('?nombre=gomez')).length, 2, 'ignora acentos');
  assert.equal((await ids('?nombre=PEREZ')).length, 2, 'ignora mayúsculas y acentos');
  assert.equal((await ids('?nombre=p%C3%A9rez')).length, 2, 'acento en la búsqueda');
  assert.equal((await ids('?nombre=ana&estado=en_proceso')).length, 1, 'criterios combinados');
  assert.equal((await ids('?estado=recibido')).length, 3);
  assert.equal((await ids(`?desde=${hoy}&hasta=${hoy}`)).length, 4);
  assert.equal((await ids('?hasta=2000-01-01')).length, 0);
  assert.equal((await ids('?entrega_desde=2100-01-01')).length, 0);
  assert.equal((await ids('?entrega_desde=2000-01-01&entrega_hasta=2100-01-01')).length, 4);
  const con = await ids('?descuento=con');
  const sin = await ids('?descuento=sin');
  assert.equal(con.length + sin.length, 4);
  assert.ok(con.length > 0 && sin.length > 0);
  assert.equal((await ids('?nombre=%25')).length, 0, 'los comodines LIKE se escapan');
  assert.equal((await ids('?nombre=_')).length, 0, 'los comodines LIKE se escapan');

  assert.equal((await adm('/pedidos?estado=cancelado')).status, 400);
  assert.equal((await adm('/pedidos?desde=2026-12-01&hasta=2026-11-01')).status, 400);
  assert.equal((await adm('/pedidos?entrega_desde=mañana')).status, 400);
  assert.equal((await adm('/pedidos?descuento=tal')).status, 400);
});

test('el panel requiere autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/pedidos')).status, 401);
  assert.equal((await fetch(base + '/admin')).status, 401);
});

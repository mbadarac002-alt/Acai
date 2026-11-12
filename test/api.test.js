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
const { DB_PATH } = require('../src/db');

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
  assert.ok([2, 5].includes(new Date(p1.fecha_entrega + 'T12:00:00Z').getUTCDay()), 'la entrega es un martes o un viernes');

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

test('comentarios del pedido: validación, historial, mail y filtro del panel', async () => {
  const otro = { nombre: 'María Núñez', dni: '27111222', direccion: 'Calle 2', telefono: '11 3333-4444' };
  const largo = 'x'.repeat(301);
  assert.equal((await post('/api/pedidos', { ...otro, cantidad: 1, comentarios: largo })).status, 400);

  // Sin comentarios: queda vacío
  let r = await post('/api/pedidos', { ...otro, cantidad: 1 });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).comentarios, '');

  // Con comentarios (se recortan espacios; 300 caracteres exactos es válido)
  r = await post('/api/pedidos', { ...otro, cantidad: 2, comentarios: '  Tocar timbre 2B <b>fuerte</b>  ' });
  assert.equal(r.status, 201);
  const p = await r.json();
  assert.equal(p.comentarios, 'Tocar timbre 2B <b>fuerte</b>');
  assert.equal((await post('/api/pedidos', { ...otro, cantidad: 1, comentarios: 'y'.repeat(300) })).status, 201);

  // Historial del cliente
  const hist = await (await fetch(`${base}/api/mis-pedidos?dni=${otro.dni}`)).json();
  assert.equal(hist.find(h => h.id === p.pedido_id).comentarios, 'Tocar timbre 2B <b>fuerte</b>');

  // Filtro del panel: sin distinguir mayúsculas ni acentos, y combinable
  const ids = async qs => (await (await adm('/pedidos' + qs)).json()).map(x => x.id);
  assert.deepEqual(await ids('?comentario=TIMBRE'), [p.pedido_id]);
  assert.deepEqual(await ids('?comentario=timbre&nombre=nunez'), [p.pedido_id]);
  assert.deepEqual(await ids('?comentario=timbre&nombre=ana'), []);
  assert.deepEqual(await ids('?comentario=noexiste'), []);
  const fila = (await (await adm('/pedidos?comentario=timbre')).json())[0];
  assert.equal(fila.comentarios, 'Tocar timbre 2B <b>fuerte</b>');
});

test('notificaciones: canal mail / telegram / ambos y validaciones', async () => {
  const base0 = { precio_balde: 1000, umbral_baldes: 10, descuento_pct: 15, hora_corte: '12:00', email_propietario: 'dueno@example.com' };
  const outbox = path.join(path.dirname(DB_PATH), 'outbox');
  const mails = () => fs.existsSync(outbox) ? fs.readdirSync(outbox).length : 0;
  const tokenOriginal = process.env.TELEGRAM_BOT_TOKEN;

  // Intercepta solo las llamadas a la API de Telegram; el resto va al servidor de test.
  const realFetch = global.fetch;
  const llamadas = [];
  let fallar = false;
  global.fetch = (url, opts) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      llamadas.push({ url: String(url), body: JSON.parse(opts.body) });
      return Promise.resolve(fallar
        ? new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
        : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  try {
    const pedir = async () => (await post('/api/pedidos', { ...cliente, cantidad: 1, comentarios: 'Tocar timbre' })).status;

    // Validaciones
    delete process.env.TELEGRAM_BOT_TOKEN;
    let r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'telegram' });
    assert.equal(r.status, 400, 'Telegram sin ID de chat');
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'telegram', telegram_chat_id: '123456789' });
    assert.equal(r.status, 400, 'Telegram sin token en el servidor');
    process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'whatsapp' });
    assert.equal(r.status, 400, 'el canal whatsapp ya no existe');
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'ambos', telegram_chat_id: 'abc' });
    assert.equal(r.status, 400, 'ID de chat no numérico');
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'mail', email_propietario: '' });
    assert.equal(r.status, 400, 'mail sin email');

    // Solo Telegram: no hay mail, hay una llamada a la API de Telegram
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'telegram', telegram_chat_id: ' -1001234567890 ' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).telegram_chat_id, '-1001234567890');
    let m0 = mails();
    assert.equal(await pedir(), 201);
    assert.equal(mails(), m0, 'solo telegram: no se manda mail');
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].url, 'https://api.telegram.org/bottoken-de-prueba/sendMessage');
    assert.equal(llamadas[0].body.chat_id, '-1001234567890');
    assert.match(llamadas[0].body.text, /Nuevo pedido #\d+/);
    assert.match(llamadas[0].body.text, /Comentarios: Tocar timbre/);

    // Solo mail: no hay llamada a Telegram
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'mail' });
    assert.equal(r.status, 200);
    m0 = mails();
    assert.equal(await pedir(), 201);
    assert.equal(mails(), m0 + 1);
    assert.equal(llamadas.length, 1);

    // Ambos
    r = await adm('/config', 'PUT', { ...base0, canal_notificacion: 'ambos' });
    assert.equal(r.status, 200);
    m0 = mails();
    assert.equal(await pedir(), 201);
    assert.equal(mails(), m0 + 1);
    assert.equal(llamadas.length, 2);

    // Si Telegram falla, el pedido y el mail igual se registran
    fallar = true;
    m0 = mails();
    assert.equal(await pedir(), 201);
    assert.equal(mails(), m0 + 1);
    fallar = false;

    // Un PUT sin los campos de notificación conserva los valores actuales
    r = await adm('/config', 'PUT', base0);
    const cfg = await r.json();
    assert.equal(cfg.canal_notificacion, 'ambos');
    assert.equal(cfg.telegram_chat_id, '-1001234567890');
  } finally {
    global.fetch = realFetch;
    if (tokenOriginal === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = tokenOriginal;
  }
});

test('borrado lógico de pedidos', async () => {
  const otro = { nombre: 'Pablo Ruiz', dni: '26000111', direccion: 'Calle 3', telefono: '11 2222-3333' };
  const crear = async cantidad => (await (await post('/api/pedidos', { ...otro, cantidad })).json());
  const ids = async qs => (await (await adm('/pedidos' + qs)).json()).map(x => x.id);
  const delAdm = id => fetch(base + '/api/admin/pedidos/' + id, { method: 'DELETE', headers: { Authorization: auth } });

  const p1 = await crear(8);   // acumulado 8
  const p2 = await crear(5);   // acumulado 13 -> supera el umbral (10): descuento
  assert.equal(p2.descuento_pct, 15);

  // Requiere autenticación
  assert.equal((await fetch(base + '/api/admin/pedidos/' + p2.pedido_id, { method: 'DELETE' })).status, 401);

  // Se marca como eliminado; no se puede eliminar dos veces ni uno inexistente
  assert.equal((await delAdm(p2.pedido_id)).status, 200);
  assert.equal((await delAdm(p2.pedido_id)).status, 404);
  assert.equal((await delAdm(999999)).status, 404);

  // El cliente ya no lo ve
  const hist = await (await fetch(base + '/api/mis-pedidos?dni=' + otro.dni)).json();
  assert.deepEqual(hist.map(h => h.id), [p1.pedido_id]);

  // El propietario tampoco, salvo que lo pida en el filtro
  assert.ok(!(await ids('')).includes(p2.pedido_id), 'por defecto se ocultan');
  assert.deepEqual(await ids('?dni=' + otro.dni + '&eliminados=solo'), [p2.pedido_id]);
  assert.deepEqual(await ids('?dni=' + otro.dni + '&eliminados=todos'), [p2.pedido_id, p1.pedido_id]);
  const eliminado = (await (await adm('/pedidos?eliminados=solo&dni=' + otro.dni)).json())[0];
  assert.match(eliminado.eliminado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal((await adm('/pedidos?eliminados=cualquiera')).status, 400);

  // Un pedido eliminado no se puede modificar
  assert.equal((await adm('/pedidos/' + p2.pedido_id, 'PATCH', { estado: 'entregado' })).status, 404);

  // No cuenta para el descuento mensual: 8 (activo) + 1 = 9, no llega al umbral
  const p3 = await crear(1);
  assert.equal(p3.baldes_acumulados, 9);
  assert.equal(p3.descuento_pct, 0);

  // Clientes: solo cuentan los pedidos activos
  const cli = (await (await adm('/clientes')).json()).find(c => c.dni === otro.dni);
  assert.equal(cli.pedidos, 2);
  assert.equal(cli.baldes_totales, 9);
});

test('el panel requiere autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/pedidos')).status, 401);
  assert.equal((await fetch(base + '/admin')).status, 401);
});

// T14 · Criterios de 9.7 que no tenían cobertura directa en los tests de cada tarea.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// ---- Base creada antes de este módulo ----
test('una base creada antes del módulo de caja arranca: crea las tablas nuevas y no cambia pedidos, clientes ni configuración', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-anterior-'));
  const archivo = path.join(dir, 'anterior.db');
  // Estructura de la versión anterior (con estado cobrado y forma de pago, sin ninguna tabla de caja)
  const viejo = new DatabaseSync(archivo);
  viejo.exec(`
    CREATE TABLE clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, dni TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, direccion TEXT NOT NULL, telefono TEXT NOT NULL, creado_en TEXT NOT NULL);
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER NOT NULL REFERENCES clientes(id), cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL, subtotal REAL NOT NULL, baldes_acumulados INTEGER NOT NULL, descuento_pct REAL NOT NULL DEFAULT 0,
      descuento_monto REAL NOT NULL DEFAULT 0, total REAL NOT NULL, fecha_pedido TEXT NOT NULL, creado_en TEXT NOT NULL, fecha_entrega TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'recibido' CHECK (estado IN ('recibido','en_proceso','entregado','cobrado')),
      actualizado_en TEXT NOT NULL, comentarios TEXT NOT NULL DEFAULT '', eliminado_en TEXT,
      pago_efectivo REAL NOT NULL DEFAULT 0, pago_transferencia REAL NOT NULL DEFAULT 0, fecha_cobro TEXT, cobro_corregido_en TEXT
    );
    CREATE TABLE config (clave TEXT PRIMARY KEY, valor TEXT);
    INSERT INTO clientes (dni, nombre, direccion, telefono, creado_en) VALUES ('30111222', 'Kiosco Sur', 'Calle 1', '11 5555-0000', '2026-10-01 10:00');
    INSERT INTO pedidos (cliente_id, cantidad, precio_unitario, subtotal, baldes_acumulados, total, fecha_pedido, creado_en, fecha_entrega, estado, actualizado_en, pago_efectivo, pago_transferencia, fecha_cobro)
      VALUES (1, 5, 10000, 50000, 5, 50000, '2026-10-02', '2026-10-02 09:00', '2026-10-06', 'cobrado', '2026-10-06 12:00', 30000, 20000, '2026-10-06 12:00');
    INSERT INTO config (clave, valor) VALUES ('precio_balde', '12345'), ('hora_corte', '11:30');
  `);
  viejo.close();

  const salida = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { db, getConfig } = require(${JSON.stringify(path.resolve(__dirname, '../src/db'))});
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    const ped = db.prepare('SELECT estado, total, pago_efectivo, pago_transferencia, fecha_cobro FROM pedidos').all().map(p => ({ ...p }));
    const c = getConfig();
    console.log(JSON.stringify({
      tablas, pedidos: ped, clientes: db.prepare('SELECT nombre FROM clientes').all().map(x => x.nombre),
      puntos: db.prepare('SELECT nombre FROM puntos_venta ORDER BY id').all().map(x => x.nombre),
      categorias: db.prepare('SELECT COUNT(*) n FROM categorias_gasto').get().n,
      precios: db.prepare('SELECT COUNT(*) n FROM precios_bowl').get().n,
      config: { precio_balde: c.precio_balde, hora_corte: c.hora_corte },
    }));
  `], { env: { ...process.env, DB_PATH: archivo }, encoding: 'utf8' });
  const r = JSON.parse(salida);
  for (const t of ['puntos_venta', 'precios_bowl', 'cierres_caja', 'categorias_gasto', 'gastos_generales']) assert.ok(r.tablas.includes(t), t);
  assert.deepEqual(r.puntos, ['Miramar 1', 'Miramar 2', 'Chapadmalal']);
  assert.equal(r.categorias, 7);
  assert.equal(r.precios, 0);
  assert.deepEqual(r.pedidos, [{ estado: 'cobrado', total: 50000, pago_efectivo: 30000, pago_transferencia: 20000, fecha_cobro: '2026-10-06 12:00' }]);
  assert.deepEqual(r.clientes, ['Kiosco Sur']);
  assert.deepEqual(r.config, { precio_balde: 12345, hora_corte: '11:30' });
});

// ---- Primer precio con vigencia posterior al día a cargar ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-criterios-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });
const cfg = { precio_balde: 1000, umbral_baldes: 0, descuento_pct: 0, hora_corte: '12:00', email_propietario: 'dueno@example.com' };

test('si el primer precio rige desde el 15/11, un cierre trabajado del 10/11 da 409; configurándolo desde el 01/11 se acepta', async () => {
  const cierre = { punto_venta_id: 1, fecha: '2025-11-10', tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 1, bowls_transferencia: 1, gastos: 0, efectivo_contado: 4000 };
  await adm('/config', 'PUT', { ...cfg, precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2025-11-15' });
  let r = await adm('/caja/cierres', 'POST', cierre);
  assert.equal(r.status, 409);
  assert.match((await r.json()).errores.join(' '), /precio del bowl/i);

  // el propietario carga el precio con una vigencia anterior (misma fecha de vigencia nueva, 01/11)
  assert.equal((await adm('/config', 'PUT', { ...cfg, precio_bowl_efectivo: 4000, precio_bowl_transferencia: 4500, precio_bowl_desde: '2025-11-01' })).status, 200);
  r = await adm('/caja/cierres', 'POST', cierre);
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.precio_bowl_efectivo, 4000);
  assert.equal(c.ventas, 8500);
});

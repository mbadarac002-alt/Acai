// T1 · Esquema del módulo de caja (spec 9.4): tablas, carga inicial y restricciones.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-caja-db-'));
const DB_FILE = path.join(tmp, 'test.db');
process.env.DB_PATH = DB_FILE;
const { db } = require('../src/db');

const nuevoCierre = (over = {}) => ({
  punto_venta_id: 1, fecha: '2026-11-10', tipo: 'trabajado', creado_en: '2026-11-10 20:00', actualizado_en: '2026-11-10 20:00', ...over,
});
const insertarCierre = (c) => db.prepare(
  `INSERT INTO cierres_caja (punto_venta_id, fecha, tipo, creado_en, actualizado_en, eliminado_en, motivo_eliminacion)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run(c.punto_venta_id, c.fecha, c.tipo, c.creado_en, c.actualizado_en, c.eliminado_en ?? null, c.motivo_eliminacion ?? null);

test('existen las tablas del módulo de caja', () => {
  const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
  for (const t of ['puntos_venta', 'precios_bowl', 'cierres_caja', 'categorias_gasto', 'gastos_generales']) {
    assert.ok(tablas.includes(t), `falta la tabla ${t}`);
  }
});

test('carga inicial: 3 puntos de venta activos', () => {
  const pv = db.prepare('SELECT nombre, activo FROM puntos_venta ORDER BY id').all();
  assert.deepEqual(pv.map(p => p.nombre), ['Miramar 1', 'Miramar 2', 'Chapadmalal']);
  assert.ok(pv.every(p => p.activo === 1));
});

test('carga inicial: 7 categorías de gasto con su tipo', () => {
  const cats = Object.fromEntries(db.prepare('SELECT nombre, tipo FROM categorias_gasto').all().map(c => [c.nombre, c.tipo]));
  assert.deepEqual(cats, {
    'mercadería': 'stock',
    'envases y descartables': 'stock',
    'publicidad': 'corriente',
    'transporte': 'corriente',
    'servicios y alquileres': 'corriente',
    'sueldos': 'corriente',
    'otros': 'corriente',
  });
});

test('el historial de precios arranca vacío', () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM precios_bowl').get().n, 0);
});

test('cierres: un solo cierre activo por punto de venta y fecha; eliminado libera la fecha', () => {
  insertarCierre(nuevoCierre());
  assert.throws(() => insertarCierre(nuevoCierre()), /UNIQUE/);
  // otro punto de venta, misma fecha: permitido
  insertarCierre(nuevoCierre({ punto_venta_id: 2 }));
  // se elimina el primero y se puede cargar uno nuevo
  db.prepare("UPDATE cierres_caja SET eliminado_en = '2026-11-11 10:00', motivo_eliminacion = 'cargado por error' WHERE punto_venta_id = 1 AND fecha = '2026-11-10'").run();
  insertarCierre(nuevoCierre());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cierres_caja WHERE punto_venta_id = 1 AND fecha = '2026-11-10'").get().n, 2);
});

test('cierres: el tipo solo admite trabajado, no_trabajado o fin_temporada', () => {
  for (const tipo of ['no_trabajado', 'fin_temporada']) insertarCierre(nuevoCierre({ fecha: '2026-11-20', tipo, punto_venta_id: tipo === 'fin_temporada' ? 3 : 1 }));
  assert.throws(() => insertarCierre(nuevoCierre({ fecha: '2026-11-21', tipo: 'otro' })), /CHECK/);
});

test('cierres: los montos calculados y cantidades tienen valor por defecto 0', () => {
  const c = db.prepare("SELECT * FROM cierres_caja WHERE punto_venta_id = 2 AND fecha = '2026-11-10'").get();
  for (const k of ['fondo_inicial', 'bowls_efectivo', 'bowls_transferencia', 'ingresos_efectivo', 'ingresos_transferencia', 'gastos', 'efectivo_esperado', 'efectivo_contado', 'diferencia']) {
    assert.equal(c[k], 0, k);
  }
  assert.equal(c.motivo, '');
  assert.equal(c.corregido_en, null);
});

test('precios del bowl: una sola fila por fecha de vigencia y precios positivos', () => {
  const ins = (d, e, t) => db.prepare('INSERT INTO precios_bowl (vigente_desde, precio_efectivo, precio_transferencia, creado_en) VALUES (?, ?, ?, ?)').run(d, e, t, '2026-11-01 09:00');
  ins('2026-11-01', 400000, 450000);
  assert.throws(() => ins('2026-11-01', 410000, 460000), /UNIQUE/);
  assert.throws(() => ins('2026-11-15', 0, 500000), /CHECK/);
});

test('gastos generales: referencia una categoría existente y el monto es positivo', () => {
  const ins = (monto, cat) => db.prepare('INSERT INTO gastos_generales (fecha, monto, categoria_id, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?)').run('2026-11-12', monto, cat, '2026-11-12 10:00', '2026-11-12 10:00');
  ins(5000000, 1);
  assert.throws(() => ins(0, 1), /CHECK/);
  assert.throws(() => ins(1000, 999), /FOREIGN KEY/);
});

test('reabrir la base no duplica la carga inicial ni pierde pedidos, clientes ni configuración', () => {
  db.prepare("INSERT INTO clientes (dni, nombre, direccion, telefono, creado_en) VALUES ('1', 'Ana', 'x', '1', '2026-11-01 10:00')").run();
  db.prepare(`INSERT INTO pedidos (cliente_id, cantidad, precio_unitario, subtotal, baldes_acumulados, total, fecha_pedido, creado_en, fecha_entrega, actualizado_en)
              VALUES (1, 2, 1000, 2000, 2, 2000, '2026-11-01', '2026-11-01 10:00', '2026-11-03', '2026-11-01 10:00')`).run();
  db.close();
  const salida = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { db, getConfig } = require(${JSON.stringify(path.resolve(__dirname, '../src/db'))});
    const n = t => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
    console.log(JSON.stringify({ pv: n('puntos_venta'), cat: n('categorias_gasto'), ped: n('pedidos'), cli: n('clientes'), balde: getConfig().precio_balde }));
  `], { env: { ...process.env, DB_PATH: DB_FILE }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(salida), { pv: 3, cat: 7, ped: 1, cli: 1, balde: 10000 });
});

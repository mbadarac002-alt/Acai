const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'acai.db'))
  || path.join(__dirname, '..', 'data', 'acai.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS clientes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dni           TEXT NOT NULL UNIQUE,
    nombre        TEXT NOT NULL,
    direccion     TEXT NOT NULL,
    telefono      TEXT NOT NULL,
    creado_en     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id         INTEGER NOT NULL REFERENCES clientes(id),
    cantidad           INTEGER NOT NULL,
    precio_unitario    REAL NOT NULL,
    subtotal           REAL NOT NULL,
    baldes_acumulados  INTEGER NOT NULL,
    descuento_pct      REAL NOT NULL DEFAULT 0,
    descuento_monto    REAL NOT NULL DEFAULT 0,
    total              REAL NOT NULL,
    fecha_pedido       TEXT NOT NULL,  -- YYYY-MM-DD (hora local)
    creado_en          TEXT NOT NULL,  -- YYYY-MM-DD HH:MM (hora local)
    fecha_entrega      TEXT NOT NULL,  -- YYYY-MM-DD
    estado             TEXT NOT NULL DEFAULT 'recibido'
                       CHECK (estado IN ('recibido','en_proceso','entregado','cobrado')),
    actualizado_en     TEXT NOT NULL,
    comentarios        TEXT NOT NULL DEFAULT '',
    eliminado_en       TEXT,
    pago_efectivo      REAL NOT NULL DEFAULT 0,  -- parte del total cobrada en efectivo (solo si estado = cobrado)
    pago_transferencia REAL NOT NULL DEFAULT 0,  -- parte del total cobrada por transferencia
    fecha_cobro        TEXT                      -- YYYY-MM-DD HH:MM (hora local) en que pasó a cobrado
  );

  CREATE TABLE IF NOT EXISTS config (
    clave  TEXT PRIMARY KEY,
    valor  TEXT
  );
`);

// Migraciones: bases creadas antes de existir ciertos campos.
const columnasPedidos = db.prepare('PRAGMA table_info(pedidos)').all().map(c => c.name);
if (!columnasPedidos.includes('comentarios')) {
  db.exec("ALTER TABLE pedidos ADD COLUMN comentarios TEXT NOT NULL DEFAULT ''");
}
// Borrado lógico: NULL = pedido activo; con valor = fecha/hora (local) en que se marcó como eliminado.
if (!columnasPedidos.includes('eliminado_en')) {
  db.exec('ALTER TABLE pedidos ADD COLUMN eliminado_en TEXT');
}

// Bases creadas antes del estado 'cobrado': SQLite no permite modificar un CHECK, así que se reconstruye
// la tabla (conservando todos los datos) con el CHECK nuevo y las columnas de forma de pago.
const sqlPedidos = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pedidos'").get().sql;
if (!sqlPedidos.includes("'cobrado'")) {
  const cols = db.prepare('PRAGMA table_info(pedidos)').all().map(c => c.name).join(', ');
  db.exec(`
    BEGIN;
    ALTER TABLE pedidos RENAME TO pedidos_vieja;
    CREATE TABLE pedidos (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id         INTEGER NOT NULL REFERENCES clientes(id),
      cantidad           INTEGER NOT NULL,
      precio_unitario    REAL NOT NULL,
      subtotal           REAL NOT NULL,
      baldes_acumulados  INTEGER NOT NULL,
      descuento_pct      REAL NOT NULL DEFAULT 0,
      descuento_monto    REAL NOT NULL DEFAULT 0,
      total              REAL NOT NULL,
      fecha_pedido       TEXT NOT NULL,
      creado_en          TEXT NOT NULL,
      fecha_entrega      TEXT NOT NULL,
      estado             TEXT NOT NULL DEFAULT 'recibido'
                         CHECK (estado IN ('recibido','en_proceso','entregado','cobrado')),
      actualizado_en     TEXT NOT NULL,
      comentarios        TEXT NOT NULL DEFAULT '',
      eliminado_en       TEXT,
      pago_efectivo      REAL NOT NULL DEFAULT 0,
      pago_transferencia REAL NOT NULL DEFAULT 0,
      fecha_cobro        TEXT
    );
    INSERT INTO pedidos (${cols}) SELECT ${cols} FROM pedidos_vieja;
    DROP TABLE pedidos_vieja;
    COMMIT;
  `);
}

// Corrección de cobros: fecha/hora local de la última corrección de la forma de pago (NULL = nunca se corrigió).
if (!db.prepare('PRAGMA table_info(pedidos)').all().some(c => c.name === 'cobro_corregido_en')) {
  db.exec('ALTER TABLE pedidos ADD COLUMN cobro_corregido_en TEXT');
}

// ---- Módulo de caja (spec 9.4) ----
// Tablas nuevas: no tocan la estructura de las existentes. Los montos van en INTEGER (centavos).
db.exec(`
  CREATE TABLE IF NOT EXISTS puntos_venta (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre  TEXT NOT NULL UNIQUE,
    activo  INTEGER NOT NULL DEFAULT 1
  );

  -- Historial de precios del bowl: el precio vigente en una fecha F es la fila con mayor vigente_desde <= F.
  CREATE TABLE IF NOT EXISTS precios_bowl (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    vigente_desde         TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
    precio_efectivo       INTEGER NOT NULL CHECK (precio_efectivo > 0),
    precio_transferencia  INTEGER NOT NULL CHECK (precio_transferencia > 0),
    creado_en             TEXT NOT NULL          -- YYYY-MM-DD HH:MM (hora local)
  );

  CREATE TABLE IF NOT EXISTS cierres_caja (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    punto_venta_id              INTEGER NOT NULL REFERENCES puntos_venta(id),
    fecha                       TEXT NOT NULL,  -- YYYY-MM-DD, día al que corresponde el cierre
    tipo                        TEXT NOT NULL CHECK (tipo IN ('trabajado','no_trabajado','fin_temporada')),
    motivo                      TEXT NOT NULL DEFAULT '',
    fondo_inicial               INTEGER NOT NULL DEFAULT 0,
    bowls_efectivo              INTEGER NOT NULL DEFAULT 0,
    bowls_transferencia         INTEGER NOT NULL DEFAULT 0,
    precio_bowl_efectivo        INTEGER,        -- precio vigente en la fecha del cierre (NULL si no trabajó)
    precio_bowl_transferencia   INTEGER,
    ingresos_efectivo           INTEGER NOT NULL DEFAULT 0,
    ingresos_transferencia      INTEGER NOT NULL DEFAULT 0,
    gastos                      INTEGER NOT NULL DEFAULT 0,
    nota_gastos                 TEXT NOT NULL DEFAULT '',
    efectivo_esperado           INTEGER NOT NULL DEFAULT 0,
    efectivo_contado            INTEGER NOT NULL DEFAULT 0,
    diferencia                  INTEGER NOT NULL DEFAULT 0,
    nota_diferencia             TEXT NOT NULL DEFAULT '',
    creado_en                   TEXT NOT NULL,
    actualizado_en              TEXT NOT NULL,
    corregido_en                TEXT,
    eliminado_en                TEXT,
    motivo_eliminacion          TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_cierres_punto_fecha
    ON cierres_caja (punto_venta_id, fecha) WHERE eliminado_en IS NULL;

  CREATE TABLE IF NOT EXISTS categorias_gasto (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre  TEXT NOT NULL UNIQUE,
    tipo    TEXT NOT NULL CHECK (tipo IN ('corriente','stock'))
  );

  CREATE TABLE IF NOT EXISTS gastos_generales (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha               TEXT NOT NULL,  -- YYYY-MM-DD de la compra
    monto               INTEGER NOT NULL CHECK (monto > 0),
    categoria_id        INTEGER NOT NULL REFERENCES categorias_gasto(id),
    nota                TEXT NOT NULL DEFAULT '',
    creado_en           TEXT NOT NULL,
    actualizado_en      TEXT NOT NULL,
    corregido_en        TEXT,
    eliminado_en        TEXT,
    motivo_eliminacion  TEXT
  );
`);

const insertPunto = db.prepare('INSERT OR IGNORE INTO puntos_venta (nombre) VALUES (?)');
for (const n of ['Miramar 1', 'Miramar 2', 'Chapadmalal']) insertPunto.run(n);

const insertCategoria = db.prepare('INSERT OR IGNORE INTO categorias_gasto (nombre, tipo) VALUES (?, ?)');
for (const [n, t] of [
  ['mercadería', 'stock'], ['envases y descartables', 'stock'],
  ['publicidad', 'corriente'], ['transporte', 'corriente'], ['servicios y alquileres', 'corriente'],
  ['sueldos', 'corriente'], ['otros', 'corriente'],
]) insertCategoria.run(n, t);

const DEFAULTS = {
  precio_balde: '10000',
  umbral_baldes: '20',
  descuento_pct: '10',
  hora_corte: '12:00',
  email_propietario: process.env.OWNER_EMAIL || '',
  telegram_chat_id: '',
  canal_notificacion: 'mail', // 'mail' | 'telegram' | 'ambos'
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) insertDefault.run(k, v);

function getConfig() {
  const rows = db.prepare('SELECT clave, valor FROM config').all();
  const c = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  return {
    precio_balde: Number(c.precio_balde),
    umbral_baldes: Number(c.umbral_baldes),
    descuento_pct: Number(c.descuento_pct),
    hora_corte: c.hora_corte || '12:00',
    email_propietario: c.email_propietario || '',
    telegram_chat_id: c.telegram_chat_id || '',
    // Un canal guardado que ya no existe (p. ej. 'whatsapp') vuelve a 'mail'.
    canal_notificacion: ['mail', 'telegram', 'ambos'].includes(c.canal_notificacion) ? c.canal_notificacion : 'mail',
  };
}

function setConfig(values) {
  const upd = db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  for (const k of Object.keys(DEFAULTS)) {
    if (values[k] !== undefined) upd.run(k, String(values[k]));
  }
}

module.exports = { db, DB_PATH, getConfig, setConfig };

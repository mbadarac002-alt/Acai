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

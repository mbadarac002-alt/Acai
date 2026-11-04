const path = require('node:path');
const express = require('express');
const { db, getConfig, setConfig } = require('./db');
const { ahoraLocal, calcularFechaEntrega, calcularPrecio } = require('./reglas');
const { enviarMail } = require('./mailer');

const app = express();
app.use(express.json());

const ESTADOS = ['recibido', 'en_proceso', 'entregado'];
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const fmtPesos = n => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtFecha = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

// ---------- Autenticación simple (HTTP Basic) para el panel del propietario ----------
function requireAdmin(req, res, next) {
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && token) {
    const [u, ...p] = Buffer.from(token, 'base64').toString().split(':');
    if (u === ADMIN_USER && p.join(':') === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Panel Acai"').status(401).send('Autenticación requerida');
}

// ---------- Página pública ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use('/static', express.static(path.join(__dirname, '..', 'public', 'static')));

app.get('/api/precio', (req, res) => {
  const c = getConfig();
  res.json({ precio_balde: c.precio_balde });
});

app.post('/api/pedidos', async (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const dni = String(req.body.dni || '').replace(/\D/g, '');
  const direccion = String(req.body.direccion || '').trim();
  const telefono = String(req.body.telefono || '').trim();
  const cantidad = Number(req.body.cantidad);

  const errores = [];
  if (!nombre) errores.push('El nombre es obligatorio.');
  if (!/^\d{7,9}$/.test(dni)) errores.push('El DNI debe tener entre 7 y 9 dígitos.');
  if (!direccion) errores.push('La dirección es obligatoria.');
  if (!/^[\d\s+()-]{6,}$/.test(telefono)) errores.push('El teléfono no es válido.');
  if (!Number.isInteger(cantidad) || cantidad < 1) errores.push('La cantidad de baldes debe ser un número entero mayor a 0.');
  if (errores.length) return res.status(400).json({ errores });

  const config = getConfig();
  const ahora = ahoraLocal();
  let resultado;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Cliente: si es su primer pedido se registra; si ya existe se actualizan sus datos de contacto.
    let cliente = db.prepare('SELECT * FROM clientes WHERE dni = ?').get(dni);
    const esNuevo = !cliente;
    if (esNuevo) {
      const r = db.prepare('INSERT INTO clientes (dni, nombre, direccion, telefono, creado_en) VALUES (?, ?, ?, ?, ?)')
        .run(dni, nombre, direccion, telefono, `${ahora.fecha} ${ahora.hora}`);
      cliente = { id: Number(r.lastInsertRowid), dni, nombre, direccion, telefono };
    } else {
      db.prepare('UPDATE clientes SET nombre = ?, direccion = ?, telefono = ? WHERE id = ?')
        .run(nombre, direccion, telefono, cliente.id);
    }

    // 2. Precio y descuento según baldes acumulados en el rango vigente.
    let baldesPrevios = 0;
    if (config.rango_desde && config.rango_hasta) {
      baldesPrevios = db.prepare(
        'SELECT COALESCE(SUM(cantidad), 0) AS total FROM pedidos WHERE cliente_id = ? AND fecha_pedido BETWEEN ? AND ?'
      ).get(cliente.id, config.rango_desde, config.rango_hasta).total;
    }
    const precio = calcularPrecio({ cantidad, fechaPedido: ahora.fecha, baldesPrevios, config });
    const fechaEntrega = calcularFechaEntrega(ahora, config.hora_corte);

    // 3. Registrar el pedido.
    const r = db.prepare(`
      INSERT INTO pedidos (cliente_id, cantidad, precio_unitario, subtotal, baldes_acumulados, descuento_pct,
                           descuento_monto, total, fecha_pedido, creado_en, fecha_entrega, estado, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recibido', ?)`
    ).run(cliente.id, cantidad, precio.precio_unitario, precio.subtotal, precio.baldes_acumulados, precio.descuento_pct,
          precio.descuento_monto, precio.total, ahora.fecha, `${ahora.fecha} ${ahora.hora}`, fechaEntrega,
          `${ahora.fecha} ${ahora.hora}`);
    db.exec('COMMIT');

    resultado = { pedido_id: Number(r.lastInsertRowid), cliente_nuevo: esNuevo, cliente, cantidad, fecha_entrega: fechaEntrega, ...precio };
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
    return res.status(500).json({ errores: ['No se pudo registrar el pedido. Intente nuevamente.'] });
  }

  // 4. Notificar al propietario (si falla el mail, el pedido igual queda registrado).
  try {
    await enviarMail({
      to: config.email_propietario,
      subject: `Nuevo pedido #${resultado.pedido_id} - ${resultado.cantidad} baldes - ${nombre}`,
      text: [
        `Se recibió un nuevo pedido.`,
        ``,
        `Pedido #${resultado.pedido_id}`,
        `Cliente: ${nombre}${resultado.cliente_nuevo ? ' (CLIENTE NUEVO)' : ''}`,
        `DNI: ${dni}`,
        `Dirección: ${direccion}`,
        `Teléfono: ${telefono}`,
        ``,
        `Cantidad: ${resultado.cantidad} baldes x ${fmtPesos(resultado.precio_unitario)}`,
        `Subtotal: ${fmtPesos(resultado.subtotal)}`,
        resultado.descuento_pct > 0
          ? `Descuento ${resultado.descuento_pct}% (${resultado.baldes_acumulados} baldes acumulados): -${fmtPesos(resultado.descuento_monto)}`
          : `Sin descuento`,
        `Total: ${fmtPesos(resultado.total)}`,
        ``,
        `Entrega: viernes ${fmtFecha(resultado.fecha_entrega)}`,
      ].join('\n'),
    });
  } catch (e) {
    console.error('[mail] Error enviando notificación:', e.message);
  }

  res.status(201).json(resultado);
});

// ---------- API del panel del propietario ----------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/config', (req, res) => res.json(getConfig()));

admin.put('/config', (req, res) => {
  const b = req.body;
  const errores = [];
  if (!(Number(b.precio_balde) > 0)) errores.push('El precio del balde debe ser mayor a 0.');
  if (!(Number.isInteger(Number(b.umbral_baldes)) && Number(b.umbral_baldes) >= 0)) errores.push('El umbral debe ser un entero mayor o igual a 0.');
  if (!(Number(b.descuento_pct) >= 0 && Number(b.descuento_pct) <= 100)) errores.push('El descuento debe estar entre 0 y 100%.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora_corte || '')) errores.push('La hora de corte debe tener formato HH:MM.');
  const fechaOk = f => f === '' || /^\d{4}-\d{2}-\d{2}$/.test(f);
  if (!fechaOk(b.rango_desde || '') || !fechaOk(b.rango_hasta || '')) errores.push('Fechas del rango inválidas.');
  if (!!b.rango_desde !== !!b.rango_hasta) errores.push('Complete ambas fechas del rango (o ninguna).');
  if (b.rango_desde && b.rango_hasta && b.rango_desde > b.rango_hasta) errores.push('La fecha "desde" debe ser anterior a "hasta".');
  if (b.email_propietario && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email_propietario)) errores.push('Email del propietario inválido.');
  if (errores.length) return res.status(400).json({ errores });

  setConfig({
    precio_balde: Number(b.precio_balde),
    umbral_baldes: Number(b.umbral_baldes),
    descuento_pct: Number(b.descuento_pct),
    rango_desde: b.rango_desde || '',
    rango_hasta: b.rango_hasta || '',
    hora_corte: b.hora_corte,
    email_propietario: b.email_propietario || '',
  });
  res.json(getConfig());
});

admin.get('/pedidos', (req, res) => {
  const { estado } = req.query;
  const where = ESTADOS.includes(estado) ? 'WHERE p.estado = ?' : '';
  const params = where ? [estado] : [];
  const rows = db.prepare(`
    SELECT p.*, c.nombre, c.dni, c.telefono, c.direccion
    FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
    ${where}
    ORDER BY p.id DESC`).all(...params);
  res.json(rows);
});

admin.patch('/pedidos/:id', (req, res) => {
  const { estado } = req.body;
  if (!ESTADOS.includes(estado)) return res.status(400).json({ errores: ['Estado inválido.'] });
  const a = ahoraLocal();
  const r = db.prepare('UPDATE pedidos SET estado = ?, actualizado_en = ? WHERE id = ?')
    .run(estado, `${a.fecha} ${a.hora}`, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ errores: ['Pedido no encontrado.'] });
  res.json({ ok: true });
});

admin.get('/clientes', (req, res) => {
  const c = getConfig();
  const rows = db.prepare(`
    SELECT c.*,
           COUNT(p.id) AS pedidos,
           COALESCE(SUM(p.cantidad), 0) AS baldes_totales,
           COALESCE(SUM(CASE WHEN p.fecha_pedido BETWEEN ? AND ? THEN p.cantidad END), 0) AS baldes_en_rango,
           COALESCE(SUM(p.total), 0) AS facturado
    FROM clientes c LEFT JOIN pedidos p ON p.cliente_id = c.id
    GROUP BY c.id
    ORDER BY c.nombre`).all(c.rango_desde || '9999-12-31', c.rango_hasta || '0000-01-01');
  res.json(rows);
});

app.use('/api/admin', admin);

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Acai pedidos escuchando en http://localhost:${PORT}`);
    console.log(`Panel del propietario: http://localhost:${PORT}/admin (usuario: ${ADMIN_USER})`);
  });
}

module.exports = app;

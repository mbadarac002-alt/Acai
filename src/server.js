const path = require('node:path');
const express = require('express');
const { db, getConfig, setConfig } = require('./db');
const { ahoraLocal, calcularFechaEntrega, calcularPrecio, mesDe, nombreDia } = require('./reglas');
const { enviarMail } = require('./mailer');
const { enviarTelegram, normalizarChatId, hayToken } = require('./telegram');

const app = express();
app.use(express.json());

const ESTADOS = ['recibido', 'en_proceso', 'entregado'];
const MAX_BALDES = 50;
const MAX_COMENTARIOS = 300;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const normalizarTexto = s => String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
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
  const comentarios = String(req.body.comentarios || '').trim();

  const errores = [];
  if (comentarios.length > MAX_COMENTARIOS) errores.push(`Los comentarios no pueden superar los ${MAX_COMENTARIOS} caracteres.`);
  if (!nombre) errores.push('El nombre es obligatorio.');
  if (!/^\d{7,9}$/.test(dni)) errores.push('El DNI debe tener entre 7 y 9 dígitos.');
  if (!direccion) errores.push('La dirección es obligatoria.');
  if (!/^[\d\s+()-]{6,}$/.test(telefono)) errores.push('El teléfono no es válido.');
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_BALDES) errores.push(`La cantidad de baldes debe ser un número entero mayor a 0 y hasta ${MAX_BALDES}.`);
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

    // 2. Precio y descuento según baldes acumulados en el mes calendario actual.
    const baldesPrevios = db.prepare(
      'SELECT COALESCE(SUM(cantidad), 0) AS total FROM pedidos WHERE cliente_id = ? AND substr(fecha_pedido, 1, 7) = ? AND eliminado_en IS NULL'
    ).get(cliente.id, mesDe(ahora.fecha)).total;
    const precio = calcularPrecio({ cantidad, baldesPrevios, config });
    const fechaEntrega = calcularFechaEntrega(ahora, config.hora_corte);

    // 3. Registrar el pedido.
    const r = db.prepare(`
      INSERT INTO pedidos (cliente_id, cantidad, precio_unitario, subtotal, baldes_acumulados, descuento_pct,
                           descuento_monto, total, fecha_pedido, creado_en, fecha_entrega, estado, actualizado_en, comentarios)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recibido', ?, ?)`
    ).run(cliente.id, cantidad, precio.precio_unitario, precio.subtotal, precio.baldes_acumulados, precio.descuento_pct,
          precio.descuento_monto, precio.total, ahora.fecha, `${ahora.fecha} ${ahora.hora}`, fechaEntrega,
          `${ahora.fecha} ${ahora.hora}`, comentarios);
    db.exec('COMMIT');

    resultado = { pedido_id: Number(r.lastInsertRowid), cliente_nuevo: esNuevo, cliente, cantidad, comentarios, fecha_entrega: fechaEntrega, ...precio };
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
    return res.status(500).json({ errores: ['No se pudo registrar el pedido. Intente nuevamente.'] });
  }

  // 4. Notificar al propietario por el/los canal(es) elegidos en el panel.
  //    Cada canal es independiente y, si falla, el pedido igual queda registrado.
  const asunto = `Nuevo pedido #${resultado.pedido_id} - ${resultado.cantidad} baldes - ${nombre}`;
  const resumenTelegram = [
    `Nuevo pedido #${resultado.pedido_id}${resultado.cliente_nuevo ? ' (cliente nuevo)' : ''}`,
    `${nombre} - DNI ${dni}`,
    `${resultado.cantidad} baldes - Total ${fmtPesos(resultado.total)}`,
    `Entrega: ${nombreDia(resultado.fecha_entrega)} ${fmtFecha(resultado.fecha_entrega)}`,
    ...(comentarios ? [`Comentarios: ${comentarios}`] : []),
  ].join('\n');
  const canal = config.canal_notificacion;
  const envios = [];
  if (canal === 'mail' || canal === 'ambos') {
    envios.push(['mail', () => enviarMail({
      to: config.email_propietario,
      subject: asunto,
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
        `Entrega: ${nombreDia(resultado.fecha_entrega)} ${fmtFecha(resultado.fecha_entrega)}`,
        ...(comentarios ? [``, `Comentarios del cliente:`, comentarios] : []),
      ].join('\n'),
    })]);
  }
  if (canal === 'telegram' || canal === 'ambos') {
    envios.push(['telegram', () => enviarTelegram({ chatId: config.telegram_chat_id, text: resumenTelegram })]);
  }
  await Promise.all(envios.map(async ([nombreCanal, enviar]) => {
    try { await enviar(); }
    catch (e) { console.error(`[${nombreCanal}] Error enviando notificación:`, e.message); }
  }));

  res.status(201).json(resultado);
});

// Historial de pedidos del cliente, identificado por DNI, con filtro opcional por fecha del pedido.
app.get('/api/mis-pedidos', (req, res) => {
  const dni = String(req.query.dni || '').replace(/\D/g, '');
  const desde = String(req.query.desde || '');
  const hasta = String(req.query.hasta || '');
  const errores = [];
  if (!/^\d{7,9}$/.test(dni)) errores.push('El DNI debe tener entre 7 y 9 dígitos.');
  const fechaOk = f => f === '' || (/^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(f + 'T00:00:00Z')));
  if (!fechaOk(desde) || !fechaOk(hasta)) errores.push('Las fechas deben tener formato AAAA-MM-DD.');
  else if (desde && hasta && desde > hasta) errores.push('La fecha "desde" debe ser anterior o igual a "hasta".');
  if (errores.length) return res.status(400).json({ errores });

  const where = ['c.dni = ?', 'p.eliminado_en IS NULL']; // los pedidos eliminados no se ven
  const params = [dni];
  if (desde) { where.push('p.fecha_pedido >= ?'); params.push(desde); }
  if (hasta) { where.push('p.fecha_pedido <= ?'); params.push(hasta); }
  const rows = db.prepare(`
    SELECT p.id, p.fecha_pedido, p.cantidad, p.precio_unitario, p.subtotal, p.descuento_pct,
           p.descuento_monto, p.total, p.fecha_entrega, p.estado, p.comentarios
    FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.id DESC`).all(...params);
  res.json(rows);
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

  // Notificaciones: lo que no se envía en el body conserva su valor actual.
  const actual = getConfig();
  const email = String(b.email_propietario ?? actual.email_propietario).trim();
  const chatIdIngresado = String(b.telegram_chat_id ?? actual.telegram_chat_id).trim();
  const canal = String(b.canal_notificacion ?? actual.canal_notificacion);
  const chatId = chatIdIngresado ? normalizarChatId(chatIdIngresado) : '';

  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errores.push('Email del propietario inválido.');
  if (chatId === null) errores.push('El ID de chat de Telegram debe ser un número (puede empezar con -, si es un grupo).');
  if (!['mail', 'telegram', 'ambos'].includes(canal)) errores.push('Canal de notificación inválido.');
  if ((canal === 'mail' || canal === 'ambos') && !email) errores.push('Para recibir avisos por mail hay que cargar el email del propietario.');
  if ((canal === 'telegram' || canal === 'ambos') && !chatId) errores.push('Para recibir avisos por Telegram hay que cargar el ID de chat del propietario.');
  if ((canal === 'telegram' || canal === 'ambos') && !hayToken()) errores.push('Falta configurar el bot de Telegram en el servidor (variable TELEGRAM_BOT_TOKEN).');
  if (errores.length) return res.status(400).json({ errores });

  setConfig({
    precio_balde: Number(b.precio_balde),
    umbral_baldes: Number(b.umbral_baldes),
    descuento_pct: Number(b.descuento_pct),
    hora_corte: b.hora_corte,
    email_propietario: email,
    telegram_chat_id: chatId || '',
    canal_notificacion: canal,
  });
  res.json(getConfig());
});

admin.get('/pedidos', (req, res) => {
  const q = k => String(req.query[k] || '').trim();
  const estado = q('estado');
  const dni = q('dni').replace(/\D/g, '');
  const nombre = q('nombre');
  const comentario = q('comentario');
  const descuento = q('descuento');
  const eliminados = q('eliminados'); // '' = solo activos | 'solo' = solo eliminados | 'todos' = ambos
  const fechas = { desde: q('desde'), hasta: q('hasta'), entrega_desde: q('entrega_desde'), entrega_hasta: q('entrega_hasta') };

  const errores = [];
  if (estado && !ESTADOS.includes(estado)) errores.push('Estado inválido.');
  if (descuento && !['con', 'sin'].includes(descuento)) errores.push('Filtro de descuento inválido.');
  if (eliminados && !['solo', 'todos'].includes(eliminados)) errores.push('Filtro de eliminados inválido.');
  for (const [k, v] of Object.entries(fechas)) {
    if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')))) errores.push(`Fecha inválida (${k}).`);
  }
  if (fechas.desde && fechas.hasta && fechas.desde > fechas.hasta) errores.push('"Pedido desde" debe ser anterior o igual a "pedido hasta".');
  if (fechas.entrega_desde && fechas.entrega_hasta && fechas.entrega_desde > fechas.entrega_hasta) errores.push('"Entrega desde" debe ser anterior o igual a "entrega hasta".');
  if (errores.length) return res.status(400).json({ errores });

  const esc = s => s.replace(/[\\%_]/g, '\\$&');
  const where = [];
  const params = [];
  if (eliminados === '') where.push('p.eliminado_en IS NULL');
  if (eliminados === 'solo') where.push('p.eliminado_en IS NOT NULL');
  if (estado) { where.push('p.estado = ?'); params.push(estado); }
  if (dni) { where.push("c.dni LIKE ? ESCAPE '\\'"); params.push(`%${esc(dni)}%`); }
  if (fechas.desde) { where.push('p.fecha_pedido >= ?'); params.push(fechas.desde); }
  if (fechas.hasta) { where.push('p.fecha_pedido <= ?'); params.push(fechas.hasta); }
  if (fechas.entrega_desde) { where.push('p.fecha_entrega >= ?'); params.push(fechas.entrega_desde); }
  if (fechas.entrega_hasta) { where.push('p.fecha_entrega <= ?'); params.push(fechas.entrega_hasta); }
  if (descuento === 'con') where.push('p.descuento_pct > 0');
  if (descuento === 'sin') where.push('p.descuento_pct = 0');

  let rows = db.prepare(`
    SELECT p.*, c.nombre, c.dni, c.telefono, c.direccion
    FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.id DESC`).all(...params);
  // Nombre y comentarios se comparan sin mayúsculas ni acentos (SQLite no los normaliza), por eso se filtran acá.
  if (nombre) {
    const buscado = normalizarTexto(nombre);
    rows = rows.filter(r => normalizarTexto(r.nombre).includes(buscado));
  }
  if (comentario) {
    const buscado = normalizarTexto(comentario);
    rows = rows.filter(r => normalizarTexto(r.comentarios).includes(buscado));
  }
  res.json(rows);
});

admin.patch('/pedidos/:id', (req, res) => {
  const { estado } = req.body;
  if (!ESTADOS.includes(estado)) return res.status(400).json({ errores: ['Estado inválido.'] });
  const a = ahoraLocal();
  const r = db.prepare('UPDATE pedidos SET estado = ?, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL')
    .run(estado, `${a.fecha} ${a.hora}`, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ errores: ['Pedido no encontrado.'] });
  res.json({ ok: true });
});

// Borrado lógico: el pedido queda en la base pero marcado como eliminado (no se ve para el cliente
// ni para el propietario salvo que este lo pida en el filtro, y no cuenta para el descuento mensual).
admin.delete('/pedidos/:id', (req, res) => {
  const a = ahoraLocal();
  const marca = `${a.fecha} ${a.hora}`;
  const r = db.prepare('UPDATE pedidos SET eliminado_en = ?, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL')
    .run(marca, marca, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ errores: ['Pedido no encontrado o ya eliminado.'] });
  res.json({ ok: true });
});

admin.get('/clientes', (req, res) => {
  const mes = mesDe(ahoraLocal().fecha);
  const rows = db.prepare(`
    SELECT c.*,
           COUNT(p.id) AS pedidos,
           COALESCE(SUM(p.cantidad), 0) AS baldes_totales,
           COALESCE(SUM(CASE WHEN substr(p.fecha_pedido, 1, 7) = ? THEN p.cantidad END), 0) AS baldes_mes,
           COALESCE(SUM(p.total), 0) AS facturado
    FROM clientes c LEFT JOIN pedidos p ON p.cliente_id = c.id AND p.eliminado_en IS NULL
    GROUP BY c.id
    ORDER BY c.nombre`).all(mes);
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

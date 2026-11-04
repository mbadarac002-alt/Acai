const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

const OUTBOX = path.join(__dirname, '..', 'data', 'outbox');

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

/**
 * Envía el mail por SMTP si está configurado. Si no, lo guarda en data/outbox/
 * (modo prototipo) para poder verlo sin un servidor de correo.
 */
async function enviarMail({ to, subject, text }) {
  if (!to) {
    console.warn('[mail] No hay email del propietario configurado; no se envía la notificación.');
    return { enviado: false, motivo: 'sin destinatario' };
  }
  if (transport) {
    await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { enviado: true, via: 'smtp' };
  }
  fs.mkdirSync(OUTBOX, { recursive: true });
  const file = path.join(OUTBOX, `${Date.now()}.txt`);
  fs.writeFileSync(file, `Para: ${to}\nAsunto: ${subject}\n\n${text}\n`);
  console.log(`[mail] SMTP no configurado. Mail guardado en ${file}`);
  return { enviado: true, via: 'archivo', archivo: file };
}

module.exports = { enviarMail };

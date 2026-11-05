const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { DB_PATH } = require('./db');

// Los mails no enviados se guardan junto a la base de datos (así persisten en el volumen).
const OUTBOX = path.join(path.dirname(DB_PATH), 'outbox');

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
 * Envía el mail usando, en orden de preferencia:
 *  1. Resend (API por HTTPS) si está RESEND_API_KEY — funciona en hostings que bloquean SMTP, como Railway.
 *  2. SMTP si está SMTP_HOST.
 *  3. Si no hay nada configurado, lo guarda como archivo en outbox/ (modo prototipo).
 */
async function enviarMail({ to, subject, text }) {
  if (!to) {
    console.warn('[mail] No hay email del propietario configurado; no se envía la notificación.');
    return { enviado: false, motivo: 'sin destinatario' };
  }
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'Pedidos Acai <onboarding@resend.dev>', to: [to], subject, text }),
    });
    if (!r.ok) throw new Error(`Resend respondió ${r.status}: ${await r.text()}`);
    return { enviado: true, via: 'resend' };
  }
  if (transport) {
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { enviado: true, via: 'smtp' };
  }
  fs.mkdirSync(OUTBOX, { recursive: true });
  const file = path.join(OUTBOX, `${Date.now()}.txt`);
  fs.writeFileSync(file, `Para: ${to}\nAsunto: ${subject}\n\n${text}\n`);
  console.log(`[mail] Sin servicio de mail configurado. Mail guardado en ${file}`);
  return { enviado: true, via: 'archivo', archivo: file };
}

module.exports = { enviarMail };

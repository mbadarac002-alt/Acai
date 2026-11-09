// Envío de avisos por Telegram mediante un bot (API oficial, gratuita).
// El token del bot va en la variable de entorno TELEGRAM_BOT_TOKEN (se crea con @BotFather).
// El destinatario se identifica con su ID de chat, que se carga en el panel.

/** Devuelve el ID de chat como texto si es válido (número, negativo para grupos), o null. */
function normalizarChatId(valor) {
  const limpio = String(valor || '').trim();
  return /^-?\d{5,20}$/.test(limpio) ? limpio : null;
}

const hayToken = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

async function enviarTelegram({ chatId, text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.warn('[telegram] Falta TELEGRAM_BOT_TOKEN o el ID de chat del propietario; no se envía la notificación.');
    return { enviado: false, motivo: 'sin token o chat_id' };
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15000),
  });
  const cuerpo = await r.json().catch(() => ({}));
  // Nunca se incluye el token en el mensaje de error.
  if (!r.ok || !cuerpo.ok) throw new Error(`Telegram respondió ${r.status}: ${cuerpo.description || 'error desconocido'}`);
  return { enviado: true, via: 'telegram' };
}

module.exports = { enviarTelegram, normalizarChatId, hayToken };

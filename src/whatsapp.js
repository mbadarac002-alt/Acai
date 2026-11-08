// Envío de WhatsApp mediante CallMeBot (servicio gratuito no oficial).
// El destinatario debe activarlo una vez enviando un mensaje al bot; ahí recibe su API key.

/** Normaliza un teléfono a formato internacional: '+' seguido de 8 a 15 dígitos. Devuelve null si no es válido. */
function normalizarTelefono(valor) {
  const limpio = String(valor || '').replace(/[\s().-]/g, '');
  return /^\+\d{8,15}$/.test(limpio) ? limpio : null;
}

async function enviarWhatsApp({ phone, apikey, text }) {
  if (!phone || !apikey) {
    console.warn('[whatsapp] Falta teléfono o API key del propietario; no se envía la notificación.');
    return { enviado: false, motivo: 'sin teléfono o apikey' };
  }
  const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({ phone, text, apikey });
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const cuerpo = await r.text();
  if (!r.ok) throw new Error(`CallMeBot respondió ${r.status}: ${cuerpo.slice(0, 200)}`);
  return { enviado: true, via: 'callmebot' };
}

module.exports = { enviarWhatsApp, normalizarTelefono };

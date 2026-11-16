// Módulo de caja: acceso a datos y rutas (las reglas puras están en caja-reglas.js).
const express = require('express');
const { db } = require('./db');
const { ahoraLocal } = require('./reglas');
const { aCentavos, aPesos, precioVigente, fechaValida } = require('./caja-reglas');

// ---------- Precios del bowl (RN-C2) ----------

/** Historial de precios en centavos, del más reciente al más antiguo. */
function historialPreciosCentavos() {
  return db.prepare('SELECT vigente_desde, precio_efectivo, precio_transferencia, creado_en FROM precios_bowl ORDER BY vigente_desde DESC').all()
    .map(f => ({ ...f }));
}

/** Los campos de precio del bowl que se agregan a la configuración (en pesos; null si todavía no hay precios vigentes hoy). */
function preciosBowlParaConfig() {
  const v = precioVigente(historialPreciosCentavos(), ahoraLocal().fecha);
  return {
    precio_bowl_efectivo: v ? aPesos(v.precio_efectivo) : null,
    precio_bowl_transferencia: v ? aPesos(v.precio_transferencia) : null,
    precio_bowl_vigente_desde: v ? v.vigente_desde : null,
  };
}

const vacio = v => v === undefined || v === null || String(v).trim() === '';

/**
 * Valida los campos de precio del bowl del body de la configuración. Son opcionales (el panel anterior no los mandaba):
 * si no viene ninguno de los dos precios, no hay cambio. Devuelve { errores, cambio } con cambio = null o
 * { efectivo, transferencia, desde } en centavos y fecha.
 */
function validarPreciosBowl(body) {
  const errores = [];
  const hayEfectivo = !vacio(body.precio_bowl_efectivo);
  const hayTransferencia = !vacio(body.precio_bowl_transferencia);
  if (!hayEfectivo && !hayTransferencia) return { errores, cambio: null };
  if (hayEfectivo !== hayTransferencia) {
    return { errores: ['Cargá los dos precios del bowl (en efectivo y por transferencia) o ninguno.'], cambio: null };
  }
  const efectivo = aCentavos(body.precio_bowl_efectivo);
  const transferencia = aCentavos(body.precio_bowl_transferencia);
  if (!(efectivo > 0)) errores.push('El precio del bowl en efectivo debe ser mayor a 0.');
  if (!(transferencia > 0)) errores.push('El precio del bowl por transferencia debe ser mayor a 0.');
  const desde = vacio(body.precio_bowl_desde) ? ahoraLocal().fecha : String(body.precio_bowl_desde).trim();
  if (!fechaValida(desde)) errores.push('La fecha desde la que rigen los precios del bowl es inválida: usá el formato AAAA-MM-DD.');
  return { errores, cambio: errores.length ? null : { efectivo, transferencia, desde } };
}

/**
 * Agrega un cambio de precios al historial. Si ya hay un cambio con esa misma fecha, lo reemplaza (corrección de un error de carga).
 * Si los precios ya son los vigentes en esa fecha, no hace nada (así guardar la configuración sin tocar los precios no ensucia el historial).
 */
function guardarPrecioBowl({ efectivo, transferencia, desde }) {
  const v = precioVigente(historialPreciosCentavos(), desde);
  if (v && v.precio_efectivo === efectivo && v.precio_transferencia === transferencia) return false;
  const a = ahoraLocal();
  db.prepare(`
    INSERT INTO precios_bowl (vigente_desde, precio_efectivo, precio_transferencia, creado_en) VALUES (?, ?, ?, ?)
    ON CONFLICT(vigente_desde) DO UPDATE SET precio_efectivo = excluded.precio_efectivo,
      precio_transferencia = excluded.precio_transferencia, creado_en = excluded.creado_en
  `).run(desde, efectivo, transferencia, `${a.fecha} ${a.hora}`);
  return true;
}

// ---------- Rutas (se montan bajo /api/admin/caja, ya protegidas por el acceso del panel) ----------
const router = express.Router();

router.get('/precios', (req, res) => {
  res.json(historialPreciosCentavos().map(f => ({
    vigente_desde: f.vigente_desde,
    precio_efectivo: aPesos(f.precio_efectivo),
    precio_transferencia: aPesos(f.precio_transferencia),
    creado_en: f.creado_en,
  })));
});

module.exports = { router, preciosBowlParaConfig, validarPreciosBowl, guardarPrecioBowl };

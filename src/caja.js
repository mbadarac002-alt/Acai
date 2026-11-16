// Módulo de caja: acceso a datos y rutas (las reglas puras están en caja-reglas.js).
const express = require('express');
const { db } = require('./db');
const { ahoraLocal } = require('./reglas');
const { aCentavos, aPesos, precioVigente, calcularCierre, calcularResultado, fechaValida, validarFecha, validarRango, AGRUPACIONES } = require('./caja-reglas');

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

// ---------- Cierres de caja (RN-C3) ----------

const TIPOS_CIERRE = ['trabajado', 'no_trabajado', 'fin_temporada'];
const MAX_MONTO_PESOS = 1e9;
const MAX_BOWLS = 100000;

const montoPesos = (errores, valor, etiqueta) => {
  const n = vacio(valor) ? NaN : Number(valor);
  if (!(Number.isFinite(n) && n >= 0 && n <= MAX_MONTO_PESOS)) {
    errores.push(`${etiqueta} debe ser un monto mayor o igual a 0 (y no superar ${MAX_MONTO_PESOS.toLocaleString('es-AR')}).`);
    return null;
  }
  return aCentavos(n);
};
const cantidadBowls = (errores, valor, etiqueta) => {
  const n = vacio(valor) ? NaN : Number(valor);
  if (!(Number.isInteger(n) && n >= 0 && n <= MAX_BOWLS)) {
    errores.push(`La cantidad de bowls vendidos ${etiqueta} debe ser un número entero mayor o igual a 0 (máximo ${MAX_BOWLS}).`);
    return null;
  }
  return n;
};

/**
 * Valida y normaliza el body de un cierre (alta y corrección). Los montos salen en centavos.
 * Para un día no trabajado o un fin de temporada se ignoran los montos que vengan: quedan en cero.
 */
function validarDatosCierre(body, hoy) {
  const errores = [];
  const b = body || {};
  const pvTexto = String(b.punto_venta_id ?? '').trim();
  const punto_venta_id = /^\d+$/.test(pvTexto) ? Number(pvTexto) : null;
  if (punto_venta_id === null) errores.push('Elegí el punto de venta.');
  const errFecha = validarFecha(b.fecha, hoy);
  if (errFecha) errores.push(errFecha);
  if (!TIPOS_CIERRE.includes(b.tipo)) errores.push('El tipo de cierre debe ser: trabajado, no_trabajado o fin_temporada.');

  const datos = { punto_venta_id, fecha: b.fecha, tipo: b.tipo, motivo: '', fondo: 0, bowlsE: 0, bowlsT: 0, gastos: 0, nota_gastos: '', contado: 0, nota_diferencia: '' };
  const texto = v => String(v ?? '').trim();
  if (b.tipo === 'trabajado') {
    datos.fondo = montoPesos(errores, b.fondo_inicial, 'El fondo inicial');
    datos.bowlsE = cantidadBowls(errores, b.bowls_efectivo, 'en efectivo');
    datos.bowlsT = cantidadBowls(errores, b.bowls_transferencia, 'por transferencia');
    datos.gastos = montoPesos(errores, b.gastos, 'Los gastos del día');
    datos.contado = montoPesos(errores, b.efectivo_contado, 'El efectivo contado');
    datos.nota_gastos = texto(b.nota_gastos);
    datos.nota_diferencia = texto(b.nota_diferencia);
  } else if (b.tipo === 'no_trabajado') {
    datos.motivo = texto(b.motivo);
    if (!datos.motivo) errores.push('Indicá el motivo por el que no se trabajó ese día.');
  } else if (b.tipo === 'fin_temporada') {
    datos.motivo = texto(b.motivo) || 'Fin de temporada';
  }
  return { errores, datos };
}

/**
 * Arma los campos que se guardan de un cierre (centavos). Para un día trabajado calcula ingresos, esperado y diferencia
 * con el precio dado; si la diferencia no es cero, la nota es obligatoria (devuelve errores).
 */
function armarFilaCierre(datos, precio) {
  const fila = {
    tipo: datos.tipo, motivo: datos.motivo, fondo_inicial: 0, bowls_efectivo: 0, bowls_transferencia: 0,
    precio_bowl_efectivo: null, precio_bowl_transferencia: null, ingresos_efectivo: 0, ingresos_transferencia: 0,
    gastos: 0, nota_gastos: '', efectivo_esperado: 0, efectivo_contado: 0, diferencia: 0, nota_diferencia: '',
  };
  if (datos.tipo !== 'trabajado') return { errores: [], fila };
  const c = calcularCierre({
    fondoInicial: datos.fondo, bowlsEfectivo: datos.bowlsE, bowlsTransferencia: datos.bowlsT,
    precioEfectivo: precio.precio_efectivo, precioTransferencia: precio.precio_transferencia,
    gastos: datos.gastos, efectivoContado: datos.contado,
  });
  if (c.diferencia !== 0 && !datos.nota_diferencia) {
    const signo = c.diferencia < 0 ? 'faltante' : 'sobrante';
    return { errores: [`El efectivo contado no coincide con el esperado (${signo} de ${pesosTexto(Math.abs(c.diferencia))}): explicá la diferencia en la nota.`], fila };
  }
  Object.assign(fila, {
    fondo_inicial: datos.fondo, bowls_efectivo: datos.bowlsE, bowls_transferencia: datos.bowlsT,
    precio_bowl_efectivo: precio.precio_efectivo, precio_bowl_transferencia: precio.precio_transferencia,
    ingresos_efectivo: c.ingresosEfectivo, ingresos_transferencia: c.ingresosTransferencia,
    gastos: datos.gastos, nota_gastos: datos.nota_gastos, efectivo_esperado: c.efectivoEsperado,
    efectivo_contado: datos.contado, diferencia: c.diferencia, nota_diferencia: datos.nota_diferencia,
  });
  return { errores: [], fila };
}

const pesosTexto = centavos => '$' + aPesos(centavos).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ahoraTexto = () => { const a = ahoraLocal(); return `${a.fecha} ${a.hora}`; };
const opcional = c => (c === null ? null : aPesos(c));

/** Un cierre tal como lo devuelve la API: montos en pesos y los totales calculados (ventas y utilidad relativa). */
function cierreParaApi(f) {
  const ventas = f.ingresos_efectivo + f.ingresos_transferencia;
  return {
    id: f.id, punto_venta_id: f.punto_venta_id, punto_venta: f.punto_venta, fecha: f.fecha, tipo: f.tipo, motivo: f.motivo,
    fondo_inicial: aPesos(f.fondo_inicial), bowls_efectivo: f.bowls_efectivo, bowls_transferencia: f.bowls_transferencia,
    precio_bowl_efectivo: opcional(f.precio_bowl_efectivo), precio_bowl_transferencia: opcional(f.precio_bowl_transferencia),
    ingresos_efectivo: aPesos(f.ingresos_efectivo), ingresos_transferencia: aPesos(f.ingresos_transferencia),
    gastos: aPesos(f.gastos), nota_gastos: f.nota_gastos, efectivo_esperado: aPesos(f.efectivo_esperado),
    efectivo_contado: aPesos(f.efectivo_contado), diferencia: aPesos(f.diferencia), nota_diferencia: f.nota_diferencia,
    ventas: aPesos(ventas), utilidad_relativa: aPesos(ventas - f.gastos),
    creado_en: f.creado_en, actualizado_en: f.actualizado_en, corregido_en: f.corregido_en,
    eliminado_en: f.eliminado_en, motivo_eliminacion: f.motivo_eliminacion,
  };
}

const SELECT_CIERRE = `SELECT c.*, p.nombre AS punto_venta FROM cierres_caja c JOIN puntos_venta p ON p.id = c.punto_venta_id`;
const cierrePorId = id => {
  const f = db.prepare(`${SELECT_CIERRE} WHERE c.id = ?`).get(id);
  return f ? cierreParaApi({ ...f }) : null;
};

const MSG_DUPLICADO = 'Ya hay un cierre cargado para ese punto de venta en esa fecha. Corregilo o eliminalo si hace falta.';
const MSG_SIN_PRECIO = 'No hay un precio del bowl configurado para esa fecha. Configurá los precios (con la fecha desde la que rigen) antes de cargar el cierre.';

// ---------- Rutas (se montan bajo /api/admin/caja, ya protegidas por el acceso del panel) ----------
const router = express.Router();

router.get('/cierres', (req, res) => {
  const q = k => String(req.query[k] ?? '').trim();
  const desde = q('desde'), hasta = q('hasta'), pv = q('punto_venta_id'), eliminados = q('eliminados');
  const errores = [];
  if (desde && !fechaValida(desde)) errores.push('La fecha "desde" es inválida: usá el formato AAAA-MM-DD.');
  if (hasta && !fechaValida(hasta)) errores.push('La fecha "hasta" es inválida: usá el formato AAAA-MM-DD.');
  if (!errores.length && desde && hasta && desde > hasta) errores.push('La fecha "desde" no puede ser posterior a "hasta".');
  if (pv && !/^\d+$/.test(pv)) errores.push('Punto de venta inválido.');
  if (eliminados && !['solo', 'todos'].includes(eliminados)) errores.push('Filtro de eliminados inválido.');
  if (errores.length) return res.status(400).json({ errores });

  const where = [], params = [];
  if (desde) { where.push('c.fecha >= ?'); params.push(desde); }
  if (hasta) { where.push('c.fecha <= ?'); params.push(hasta); }
  if (pv) { where.push('c.punto_venta_id = ?'); params.push(Number(pv)); }
  if (eliminados === '') where.push('c.eliminado_en IS NULL');
  else if (eliminados === 'solo') where.push('c.eliminado_en IS NOT NULL');
  const filas = db.prepare(`${SELECT_CIERRE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.fecha DESC, c.punto_venta_id, c.id DESC`).all(...params);
  res.json(filas.map(f => cierreParaApi({ ...f })));
});

router.post('/cierres', (req, res) => {
  const { errores, datos } = validarDatosCierre(req.body, ahoraLocal().fecha);
  if (errores.length) return res.status(400).json({ errores });

  const pv = db.prepare('SELECT id FROM puntos_venta WHERE id = ? AND activo = 1').get(datos.punto_venta_id);
  if (!pv) return res.status(404).json({ errores: ['No se encontró el punto de venta, o está inactivo.'] });
  const existente = db.prepare('SELECT id FROM cierres_caja WHERE punto_venta_id = ? AND fecha = ? AND eliminado_en IS NULL').get(datos.punto_venta_id, datos.fecha);
  if (existente) return res.status(409).json({ errores: [MSG_DUPLICADO] });

  const precio = datos.tipo === 'trabajado' ? precioVigente(historialPreciosCentavos(), datos.fecha) : null;
  if (datos.tipo === 'trabajado' && !precio) return res.status(409).json({ errores: [MSG_SIN_PRECIO] });

  const armado = armarFilaCierre(datos, precio);
  if (armado.errores.length) return res.status(400).json({ errores: armado.errores });

  const f = armado.fila, ahora = ahoraTexto();
  let id;
  try {
    id = Number(db.prepare(`
      INSERT INTO cierres_caja (punto_venta_id, fecha, tipo, motivo, fondo_inicial, bowls_efectivo, bowls_transferencia,
        precio_bowl_efectivo, precio_bowl_transferencia, ingresos_efectivo, ingresos_transferencia, gastos, nota_gastos,
        efectivo_esperado, efectivo_contado, diferencia, nota_diferencia, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(datos.punto_venta_id, datos.fecha, f.tipo, f.motivo, f.fondo_inicial, f.bowls_efectivo, f.bowls_transferencia,
      f.precio_bowl_efectivo, f.precio_bowl_transferencia, f.ingresos_efectivo, f.ingresos_transferencia, f.gastos, f.nota_gastos,
      f.efectivo_esperado, f.efectivo_contado, f.diferencia, f.nota_diferencia, ahora, ahora).lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ errores: [MSG_DUPLICADO] }); // carga simultánea
    throw e;
  }
  res.status(201).json(cierrePorId(id));
});

const cierreActivo = id => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM cierres_caja WHERE id = ? AND eliminado_en IS NULL').get(Number(id)) : undefined);
const MSG_CIERRE_NO_ENCONTRADO = 'No se encontró el cierre. Puede que ya haya sido eliminado: actualizá el listado.';

router.put('/cierres/:id', (req, res) => {
  const actual = cierreActivo(req.params.id);
  if (!actual) return res.status(404).json({ errores: [MSG_CIERRE_NO_ENCONTRADO] });

  const { errores, datos } = validarDatosCierre(req.body, ahoraLocal().fecha);
  if (errores.length) return res.status(400).json({ errores });

  const pv = db.prepare('SELECT id FROM puntos_venta WHERE id = ? AND activo = 1').get(datos.punto_venta_id);
  if (!pv) return res.status(404).json({ errores: ['No se encontró el punto de venta, o está inactivo.'] });
  const otro = db.prepare('SELECT id FROM cierres_caja WHERE punto_venta_id = ? AND fecha = ? AND eliminado_en IS NULL AND id <> ?').get(datos.punto_venta_id, datos.fecha, actual.id);
  if (otro) return res.status(409).json({ errores: [MSG_DUPLICADO] });

  // Se conservan los precios que el cierre ya tenía, salvo que cambie la fecha o que antes no tuviera (no trabajado).
  let precio = null;
  if (datos.tipo === 'trabajado') {
    if (actual.precio_bowl_efectivo !== null && datos.fecha === actual.fecha) {
      precio = { precio_efectivo: actual.precio_bowl_efectivo, precio_transferencia: actual.precio_bowl_transferencia };
    } else {
      precio = precioVigente(historialPreciosCentavos(), datos.fecha);
      if (!precio) return res.status(409).json({ errores: [MSG_SIN_PRECIO] });
    }
  }
  const armado = armarFilaCierre(datos, precio);
  if (armado.errores.length) return res.status(400).json({ errores: armado.errores });

  const f = armado.fila, ahora = ahoraTexto();
  try {
    db.prepare(`
      UPDATE cierres_caja SET punto_venta_id = ?, fecha = ?, tipo = ?, motivo = ?, fondo_inicial = ?, bowls_efectivo = ?,
        bowls_transferencia = ?, precio_bowl_efectivo = ?, precio_bowl_transferencia = ?, ingresos_efectivo = ?,
        ingresos_transferencia = ?, gastos = ?, nota_gastos = ?, efectivo_esperado = ?, efectivo_contado = ?, diferencia = ?,
        nota_diferencia = ?, actualizado_en = ?, corregido_en = ?
      WHERE id = ?
    `).run(datos.punto_venta_id, datos.fecha, f.tipo, f.motivo, f.fondo_inicial, f.bowls_efectivo, f.bowls_transferencia,
      f.precio_bowl_efectivo, f.precio_bowl_transferencia, f.ingresos_efectivo, f.ingresos_transferencia, f.gastos, f.nota_gastos,
      f.efectivo_esperado, f.efectivo_contado, f.diferencia, f.nota_diferencia, ahora, ahora, actual.id);
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ errores: [MSG_DUPLICADO] });
    throw e;
  }
  res.json(cierrePorId(actual.id));
});

router.delete('/cierres/:id', (req, res) => {
  const actual = cierreActivo(req.params.id);
  if (!actual) return res.status(404).json({ errores: [MSG_CIERRE_NO_ENCONTRADO] });
  const motivo = String(req.body?.motivo ?? '').trim();
  if (!motivo) return res.status(400).json({ errores: ['Indicá el motivo por el que se elimina el cierre.'] });
  db.prepare('UPDATE cierres_caja SET eliminado_en = ?, motivo_eliminacion = ?, actualizado_en = ? WHERE id = ?')
    .run(ahoraTexto(), motivo, ahoraTexto(), actual.id);
  res.json(cierrePorId(actual.id));
});

// ---------- Gastos generales (RN-C5) ----------

/** Valida y normaliza el body de un gasto general (alta y corrección). El monto sale en centavos. */
function validarDatosGasto(body, hoy) {
  const errores = [];
  const b = body || {};
  const montoNum = vacio(b.monto) ? NaN : Number(b.monto);
  const monto = Number.isFinite(montoNum) ? aCentavos(montoNum) : NaN;
  if (!(monto > 0 && montoNum <= MAX_MONTO_PESOS)) {
    errores.push(`El monto debe ser mayor a 0 (y no superar ${MAX_MONTO_PESOS.toLocaleString('es-AR')}).`);
  }
  const catTexto = String(b.categoria_id ?? '').trim();
  const categoria = /^\d+$/.test(catTexto)
    ? db.prepare('SELECT id FROM categorias_gasto WHERE id = ?').get(Number(catTexto)) : undefined;
  if (!categoria) errores.push('Elegí una categoría de gasto válida.');
  const errFecha = validarFecha(b.fecha, hoy);
  if (errFecha) errores.push(errFecha);
  return { errores, datos: { fecha: b.fecha, monto, categoria_id: categoria ? categoria.id : null, nota: String(b.nota ?? '').trim() } };
}

const SELECT_GASTO = `SELECT g.*, c.nombre AS categoria, c.tipo FROM gastos_generales g JOIN categorias_gasto c ON c.id = g.categoria_id`;

function gastoParaApi(f) {
  return {
    id: f.id, fecha: f.fecha, monto: aPesos(f.monto), categoria_id: f.categoria_id, categoria: f.categoria, tipo: f.tipo, nota: f.nota,
    creado_en: f.creado_en, actualizado_en: f.actualizado_en, corregido_en: f.corregido_en,
    eliminado_en: f.eliminado_en, motivo_eliminacion: f.motivo_eliminacion,
  };
}
const gastoPorId = id => {
  const f = db.prepare(`${SELECT_GASTO} WHERE g.id = ?`).get(id);
  return f ? gastoParaApi({ ...f }) : null;
};

router.get('/categorias', (req, res) => {
  res.json(db.prepare('SELECT id, nombre, tipo FROM categorias_gasto ORDER BY id').all().map(c => ({ ...c })));
});

router.get('/gastos', (req, res) => {
  const q = k => String(req.query[k] ?? '').trim();
  const desde = q('desde'), hasta = q('hasta'), cat = q('categoria_id'), eliminados = q('eliminados');
  const errores = [];
  if (desde && !fechaValida(desde)) errores.push('La fecha "desde" es inválida: usá el formato AAAA-MM-DD.');
  if (hasta && !fechaValida(hasta)) errores.push('La fecha "hasta" es inválida: usá el formato AAAA-MM-DD.');
  if (!errores.length && desde && hasta && desde > hasta) errores.push('La fecha "desde" no puede ser posterior a "hasta".');
  if (cat && !/^\d+$/.test(cat)) errores.push('Categoría inválida.');
  if (eliminados && !['solo', 'todos'].includes(eliminados)) errores.push('Filtro de eliminados inválido.');
  if (errores.length) return res.status(400).json({ errores });

  const where = [], params = [];
  if (desde) { where.push('g.fecha >= ?'); params.push(desde); }
  if (hasta) { where.push('g.fecha <= ?'); params.push(hasta); }
  if (cat) { where.push('g.categoria_id = ?'); params.push(Number(cat)); }
  if (eliminados === '') where.push('g.eliminado_en IS NULL');
  else if (eliminados === 'solo') where.push('g.eliminado_en IS NOT NULL');
  const filas = db.prepare(`${SELECT_GASTO} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.fecha DESC, g.id DESC`).all(...params);
  res.json(filas.map(f => gastoParaApi({ ...f })));
});

router.post('/gastos', (req, res) => {
  const { errores, datos } = validarDatosGasto(req.body, ahoraLocal().fecha);
  if (errores.length) return res.status(400).json({ errores });
  const ahora = ahoraTexto();
  const id = Number(db.prepare(`
    INSERT INTO gastos_generales (fecha, monto, categoria_id, nota, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)
  `).run(datos.fecha, datos.monto, datos.categoria_id, datos.nota, ahora, ahora).lastInsertRowid);
  res.status(201).json(gastoPorId(id));
});

const gastoActivo = id => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM gastos_generales WHERE id = ? AND eliminado_en IS NULL').get(Number(id)) : undefined);
const MSG_GASTO_NO_ENCONTRADO = 'No se encontró el gasto. Puede que ya haya sido eliminado: actualizá el listado.';

router.put('/gastos/:id', (req, res) => {
  const actual = gastoActivo(req.params.id);
  if (!actual) return res.status(404).json({ errores: [MSG_GASTO_NO_ENCONTRADO] });
  const { errores, datos } = validarDatosGasto(req.body, ahoraLocal().fecha);
  if (errores.length) return res.status(400).json({ errores });
  const ahora = ahoraTexto();
  db.prepare('UPDATE gastos_generales SET fecha = ?, monto = ?, categoria_id = ?, nota = ?, actualizado_en = ?, corregido_en = ? WHERE id = ?')
    .run(datos.fecha, datos.monto, datos.categoria_id, datos.nota, ahora, ahora, actual.id);
  res.json(gastoPorId(actual.id));
});

router.delete('/gastos/:id', (req, res) => {
  const actual = gastoActivo(req.params.id);
  if (!actual) return res.status(404).json({ errores: [MSG_GASTO_NO_ENCONTRADO] });
  const motivo = String(req.body?.motivo ?? '').trim();
  if (!motivo) return res.status(400).json({ errores: ['Indicá el motivo por el que se elimina el gasto.'] });
  const ahora = ahoraTexto();
  db.prepare('UPDATE gastos_generales SET eliminado_en = ?, motivo_eliminacion = ?, actualizado_en = ? WHERE id = ?').run(ahora, motivo, ahora, actual.id);
  res.json(gastoPorId(actual.id));
});

// ---------- Resumen (RN-C1, RN-C6) ----------

/**
 * Resumen de un período [desde, hasta] (inclusive). Todo se calcula en centavos y sale en pesos.
 * - Mayorista: pedidos cobrados y no eliminados, por fecha de cobro.
 * - Minorista: cierres activos de días trabajados (los demás tipos solo cuentan como días no trabajados).
 * - Gastos generales: por la fecha del gasto (imputación por caja).
 */
function resumenDePeriodo({ periodo, desde, hasta }) {
  let mayEfectivo = 0, mayTransferencia = 0;
  const pedidos = db.prepare(`
    SELECT pago_efectivo, pago_transferencia FROM pedidos
    WHERE estado = 'cobrado' AND eliminado_en IS NULL AND substr(fecha_cobro, 1, 10) BETWEEN ? AND ?
  `).all(desde, hasta);
  for (const p of pedidos) { mayEfectivo += aCentavos(p.pago_efectivo); mayTransferencia += aCentavos(p.pago_transferencia); }

  const cierres = db.prepare(`
    SELECT punto_venta_id, tipo, bowls_efectivo, bowls_transferencia, ingresos_efectivo, ingresos_transferencia, gastos, diferencia
    FROM cierres_caja WHERE eliminado_en IS NULL AND fecha BETWEEN ? AND ?
  `).all(desde, hasta);
  const puntos = db.prepare('SELECT id, nombre FROM puntos_venta WHERE activo = 1 ORDER BY id').all().map(pv => {
    const x = { bowlsE: 0, bowlsT: 0, ventasE: 0, ventasT: 0, gastos: 0, diferencia: 0, trabajados: 0, noTrabajados: 0 };
    for (const c of cierres.filter(c => c.punto_venta_id === pv.id)) {
      if (c.tipo === 'trabajado') {
        x.trabajados++; x.bowlsE += c.bowls_efectivo; x.bowlsT += c.bowls_transferencia;
        x.ventasE += c.ingresos_efectivo; x.ventasT += c.ingresos_transferencia; x.gastos += c.gastos; x.diferencia += c.diferencia;
      } else x.noTrabajados++;
    }
    return { pv, x };
  });
  const suma = campo => puntos.reduce((s, { x }) => s + x[campo], 0);
  const minorista = {
    bowls_efectivo: suma('bowlsE'), bowls_transferencia: suma('bowlsT'),
    ventas_efectivo: suma('ventasE'), ventas_transferencia: suma('ventasT'), gastos: suma('gastos'),
  };
  minorista.ventas_total = minorista.ventas_efectivo + minorista.ventas_transferencia;

  const porCategoria = db.prepare(`
    SELECT c.nombre AS categoria, c.tipo, SUM(g.monto) AS monto
    FROM gastos_generales g JOIN categorias_gasto c ON c.id = g.categoria_id
    WHERE g.eliminado_en IS NULL AND g.fecha BETWEEN ? AND ?
    GROUP BY c.id ORDER BY c.id
  `).all(desde, hasta).map(f => ({ ...f }));
  const generales = { corrientes: 0, stock: 0 };
  for (const f of porCategoria) generales[f.tipo === 'stock' ? 'stock' : 'corrientes'] += f.monto;
  const gastosGenerales = generales.corrientes + generales.stock;

  const mayoristaTotal = mayEfectivo + mayTransferencia;
  const r = calcularResultado({ ventasMayorista: mayoristaTotal, ventasMinorista: minorista.ventas_total, gastosPuntosVenta: minorista.gastos, gastosGenerales });

  return {
    periodo, desde, hasta,
    mayorista: { efectivo: aPesos(mayEfectivo), transferencia: aPesos(mayTransferencia), total: aPesos(mayoristaTotal), pedidos: pedidos.length },
    minorista: {
      bowls_efectivo: minorista.bowls_efectivo, bowls_transferencia: minorista.bowls_transferencia,
      ventas_efectivo: aPesos(minorista.ventas_efectivo), ventas_transferencia: aPesos(minorista.ventas_transferencia),
      ventas_total: aPesos(minorista.ventas_total), gastos: aPesos(minorista.gastos),
      utilidad_relativa: aPesos(minorista.ventas_total - minorista.gastos),
      puntos: puntos.map(({ pv, x }) => ({
        punto_venta_id: pv.id, nombre: pv.nombre, bowls_efectivo: x.bowlsE, bowls_transferencia: x.bowlsT,
        ventas_efectivo: aPesos(x.ventasE), ventas_transferencia: aPesos(x.ventasT), ventas_total: aPesos(x.ventasE + x.ventasT),
        gastos: aPesos(x.gastos), utilidad_relativa: aPesos(x.ventasE + x.ventasT - x.gastos),
        dias_trabajados: x.trabajados, dias_no_trabajados: x.noTrabajados, diferencia_caja: aPesos(x.diferencia),
      })),
    },
    ventas_totales: aPesos(r.ventasTotales),
    gastos_puntos_venta: aPesos(minorista.gastos),
    utilidad_relativa: aPesos(r.utilidadRelativa),
    gastos_generales: {
      corrientes: aPesos(generales.corrientes), stock: aPesos(generales.stock), total: aPesos(gastosGenerales),
      por_categoria: porCategoria.map(f => ({ categoria: f.categoria, tipo: f.tipo, monto: aPesos(f.monto) })),
    },
    resultado: aPesos(r.resultado),
  };
}

router.get('/resumen', (req, res) => {
  const q = k => String(req.query[k] ?? '').trim();
  const desde = q('desde'), hasta = q('hasta'), agrupar = q('agrupar') || 'total';
  const errores = [];
  const errRango = validarRango(desde, hasta);
  if (errRango) errores.push(errRango);
  if (!AGRUPACIONES.includes(agrupar)) errores.push(`La agrupación debe ser: ${AGRUPACIONES.join(', ')}.`);
  else if (agrupar !== 'total') errores.push('La agrupación por día, semana o mes todavía no está disponible.');
  if (errores.length) return res.status(400).json({ errores });
  res.json({ desde, hasta, agrupar, periodos: [resumenDePeriodo({ periodo: 'total', desde, hasta })] });
});

function listarPuntosVenta(req, res) {
  res.json(db.prepare('SELECT id, nombre, activo FROM puntos_venta ORDER BY id').all().map(p => ({ ...p })));
}

router.get('/precios', (req, res) => {
  res.json(historialPreciosCentavos().map(f => ({
    vigente_desde: f.vigente_desde,
    precio_efectivo: aPesos(f.precio_efectivo),
    precio_transferencia: aPesos(f.precio_transferencia),
    creado_en: f.creado_en,
  })));
});

module.exports = { router, listarPuntosVenta, preciosBowlParaConfig, validarPreciosBowl, guardarPrecioBowl };

// Cálculo en vivo de la pantalla de caja. Es solo una vista previa: el que guarda y valida es el servidor
// (src/caja-reglas.js), y test/caja-calculo-ui.test.js comprueba que dan exactamente lo mismo.
// Funciona en el navegador (window.CajaCalculo) y en Node (module.exports).
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.CajaCalculo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** Pesos (número o texto) a centavos enteros. */
  function aCentavos(pesos) { return Math.round(Number(pesos) * 100); }

  /** Precio vigente en una fecha: la fila con la mayor vigente_desde <= fecha. null si no hay. */
  function precioVigente(historial, fecha) {
    let vigente = null;
    for (const p of historial) {
      if (p.vigente_desde <= fecha && (!vigente || p.vigente_desde > vigente.vigente_desde)) vigente = p;
    }
    return vigente;
  }

  /** Cierre de un día trabajado. Todo en centavos (los bowls, cantidades enteras). */
  function calcularCierre({ fondoInicial, bowlsEfectivo, bowlsTransferencia, precioEfectivo, precioTransferencia, gastos, efectivoContado }) {
    const ingresosEfectivo = bowlsEfectivo * precioEfectivo;
    const ingresosTransferencia = bowlsTransferencia * precioTransferencia;
    const efectivoEsperado = fondoInicial + ingresosEfectivo - gastos;
    const ventas = ingresosEfectivo + ingresosTransferencia;
    return { ingresosEfectivo, ingresosTransferencia, efectivoEsperado, diferencia: efectivoContado - efectivoEsperado, ventas, utilidad: ventas - gastos };
  }

  /** Clase de color de la diferencia de caja: cero (ok), faltante o sobrante. */
  function claseDiferencia(centavos) {
    if (centavos === 0) return 'dif-ok';
    return centavos < 0 ? 'dif-falta' : 'dif-sobra';
  }

  /** Totales (en centavos) de un listado de gastos generales: los eliminados no cuentan, solo se informa cuántos hay. */
  function resumirGastos(lista) {
    const r = { cantidad: 0, total: 0, stock: 0, corrientes: 0, eliminados: 0 };
    for (const g of lista) {
      if (g.eliminado_en) { r.eliminados++; continue; }
      const m = aCentavos(g.monto);
      r.cantidad++; r.total += m;
      if (g.tipo === 'stock') r.stock += m; else r.corrientes += m;
    }
    return r;
  }

  // ---- Fechas ('AAAA-MM-DD'), etiquetas y atajos de rango del resumen ----
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function sumarDias(fecha, dias) {
    const d = new Date(fecha + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }
  const diaDeSemana = fecha => new Date(fecha + 'T12:00:00Z').getUTCDay(); // 0 = domingo
  /** Lunes de la semana (lunes a domingo) de una fecha. */
  function lunesDe(fecha) { return sumarDias(fecha, -((diaDeSemana(fecha) + 6) % 7)); }

  const ddmm = f => f.slice(8) + '/' + f.slice(5, 7);
  /** 'mié 12/11/25' */
  function diaCorto(fecha) { return DIAS[diaDeSemana(fecha)] + ' ' + ddmm(fecha) + '/' + fecha.slice(2, 4); }

  /** Texto de un período del resumen según la agrupación (los límites de semanas y meses parciales son los reales). */
  function etiquetaPeriodo(p, agrupar) {
    if (agrupar === 'dia') return diaCorto(p.periodo);
    if (agrupar === 'semana') {
      const semana = Number(p.periodo.slice(p.periodo.indexOf('W') + 1));
      return 'Sem. ' + semana + ' · ' + (p.desde === p.hasta ? ddmm(p.desde) : ddmm(p.desde) + ' al ' + ddmm(p.hasta));
    }
    if (agrupar === 'mes') return MESES[Number(p.periodo.slice(5, 7)) - 1] + ' ' + p.periodo.slice(0, 4);
    return 'Total del rango';
  }

  /** Rango de fechas de un atajo: hoy, semana (desde el lunes), mes (desde el día 1) o 30dias. */
  function rangoPreset(nombre, hoy) {
    if (nombre === 'hoy') return { desde: hoy, hasta: hoy };
    if (nombre === 'semana') return { desde: lunesDe(hoy), hasta: hoy };
    if (nombre === 'mes') return { desde: hoy.slice(0, 8) + '01', hasta: hoy };
    if (nombre === '30dias') return { desde: sumarDias(hoy, -29), hasta: hoy };
    throw new Error('Atajo desconocido: ' + nombre);
  }

  return { aCentavos, precioVigente, calcularCierre, claseDiferencia, resumirGastos, sumarDias, lunesDe, diaCorto, etiquetaPeriodo, rangoPreset };
});

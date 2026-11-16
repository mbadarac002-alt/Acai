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

  return { aCentavos, precioVigente, calcularCierre, claseDiferencia, resumirGastos };
});

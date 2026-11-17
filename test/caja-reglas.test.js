// T2 · Funciones puras del módulo de caja (spec 9.3). Los números salen de los ejemplos del spec 9.7.
const test = require('node:test');
const assert = require('node:assert');
const {
  aCentavos, aPesos, precioVigente, calcularCierre, calcularResultado,
  fechaValida, validarFecha, validarRango, diasDelRango, lunesDe, periodoDe, periodosDelRango, diasSinCierre,
} = require('../src/caja-reglas');

// ---- Dinero ----
test('pesos a centavos y de vuelta, sin errores de coma flotante', () => {
  assert.equal(aCentavos(4000), 400000);
  assert.equal(aCentavos(0.1 + 0.2), 30);
  assert.equal(aCentavos(1234.56), 123456);
  assert.equal(aCentavos('2500.5'), 250050);
  assert.equal(aPesos(123456), 1234.56);
  assert.equal(aPesos(-50000), -500);
});

// ---- Precio vigente por fecha (RN-C2) ----
const historial = [
  { vigente_desde: '2026-11-15', precio_efectivo: 500000, precio_transferencia: 550000 },
  { vigente_desde: '2026-11-01', precio_efectivo: 400000, precio_transferencia: 450000 },
];
test('precio vigente: el último cambio con vigente_desde <= fecha del cierre', () => {
  assert.equal(precioVigente(historial, '2026-11-12').precio_efectivo, 400000);
  assert.equal(precioVigente(historial, '2026-11-14').precio_efectivo, 400000);
  assert.equal(precioVigente(historial, '2026-11-15').precio_efectivo, 500000);
  assert.equal(precioVigente(historial, '2026-11-16').precio_transferencia, 550000);
  assert.equal(precioVigente(historial, '2026-11-01').precio_efectivo, 400000);
});
test('precio vigente: null si la fecha es anterior al primer precio o no hay historial', () => {
  assert.equal(precioVigente(historial, '2026-10-31'), null);
  assert.equal(precioVigente([], '2026-11-12'), null);
});

// ---- Cierre de día trabajado (RN-C3) ----
const base = { fondoInicial: 500000, bowlsEfectivo: 5, bowlsTransferencia: 2, precioEfectivo: 400000, precioTransferencia: 450000, gastos: 300000 };

test('cierre: ingresos por bowls, esperado, diferencia, ventas y utilidad (5.000 + 20.000 − 3.000 = 22.000)', () => {
  const c = calcularCierre({ ...base, efectivoContado: 2200000 });
  assert.equal(c.ingresosEfectivo, 2000000);
  assert.equal(c.ingresosTransferencia, 900000);
  assert.equal(c.efectivoEsperado, 2200000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.ventas, 2900000);
  assert.equal(c.utilidad, 2600000);
});
test('cierre: faltante de $500 (contado 21.500)', () => {
  assert.equal(calcularCierre({ ...base, efectivoContado: 2150000 }).diferencia, -50000);
});
test('cierre: sobrante', () => {
  assert.equal(calcularCierre({ ...base, efectivoContado: 2250000 }).diferencia, 50000);
});
test('cierre: las transferencias no cambian el efectivo esperado ni la diferencia', () => {
  const a = calcularCierre({ ...base, bowlsTransferencia: 0, efectivoContado: 2200000 });
  const b = calcularCierre({ ...base, bowlsTransferencia: 9, efectivoContado: 2200000 });
  assert.equal(a.efectivoEsperado, b.efectivoEsperado);
  assert.equal(a.diferencia, b.diferencia);
  assert.ok(b.ventas > a.ventas);
});
test('cierre: la utilidad no incluye el fondo inicial ni la diferencia de caja', () => {
  const a = calcularCierre({ ...base, fondoInicial: 0, efectivoContado: 0 });
  const b = calcularCierre({ ...base, fondoInicial: 9000000, efectivoContado: 5 });
  assert.equal(a.utilidad, b.utilidad);
});
test('cierre: día trabajado sin ventas (todo en cero, contado igual al fondo)', () => {
  const c = calcularCierre({ fondoInicial: 500000, bowlsEfectivo: 0, bowlsTransferencia: 0, precioEfectivo: 400000, precioTransferencia: 450000, gastos: 0, efectivoContado: 500000 });
  assert.deepEqual(c, { ingresosEfectivo: 0, ingresosTransferencia: 0, efectivoEsperado: 500000, diferencia: 0, ventas: 0, utilidad: 0 });
});
test('cierre: el esperado puede ser negativo si los gastos superan al efectivo', () => {
  const c = calcularCierre({ fondoInicial: 0, bowlsEfectivo: 1, bowlsTransferencia: 0, precioEfectivo: 400000, precioTransferencia: 450000, gastos: 1000000, efectivoContado: 0 });
  assert.equal(c.efectivoEsperado, -600000);
  assert.equal(c.diferencia, 600000);
});

// ---- Resultado (RN-C6) ----
test('resultado: 5.000 + 12.000 − 2.000 − 4.000 = 11.000, con ventas totales y utilidad relativa', () => {
  const r = calcularResultado({ ventasMayorista: 500000, ventasMinorista: 1200000, gastosPuntosVenta: 200000, gastosGenerales: 400000 });
  assert.deepEqual(r, { ventasTotales: 1700000, utilidadRelativa: 1500000, resultado: 1100000 });
});
test('resultado: semana sin ventas con un gasto general de $4.000 da −4.000', () => {
  const r = calcularResultado({ ventasMayorista: 0, ventasMinorista: 0, gastosPuntosVenta: 0, gastosGenerales: 400000 });
  assert.deepEqual(r, { ventasTotales: 0, utilidadRelativa: 0, resultado: -400000 });
});

// ---- Fechas y rangos ----
test('fechaValida: formato y existencia real', () => {
  assert.equal(fechaValida('2026-11-12'), true);
  assert.equal(fechaValida('2028-02-29'), true);
  for (const f of ['2026-02-30', '2026-13-01', '2026-11-1', '12/11/2026', '', null, undefined, 20261112]) assert.equal(fechaValida(f), false, String(f));
});
test('validarFecha: inválida y futura devuelven un mensaje; hoy y el pasado no', () => {
  assert.equal(validarFecha('2026-11-16', '2026-11-16'), null);
  assert.equal(validarFecha('2026-11-01', '2026-11-16'), null);
  assert.match(validarFecha('2026-11-17', '2026-11-16'), /futura/i);
  assert.match(validarFecha('2026-02-30', '2026-11-16'), /inválida/i);
});
test('validarRango: desde <= hasta, fechas válidas y máximo 366 días', () => {
  assert.equal(validarRango('2026-11-01', '2026-11-30'), null);
  assert.equal(validarRango('2026-11-01', '2026-11-01'), null);
  assert.equal(validarRango('2026-01-01', '2026-12-31'), null);          // 365 días
  assert.equal(validarRango('2028-01-01', '2028-12-31'), null);          // 366 días (bisiesto)
  assert.equal(validarRango('2026-01-01', '2027-01-01'), null);          // 366 días inclusive: es el máximo permitido
});
test('validarRango: rechaza desde > hasta, fechas mal formadas y más de 366 días', () => {
  assert.match(validarRango('2026-11-10', '2026-11-01'), /desde/i);
  assert.ok(validarRango('2026-11-xx', '2026-11-01'));
  assert.ok(validarRango(undefined, '2026-11-01'));
  assert.match(validarRango('2026-01-01', '2027-01-02'), /366/);
});
test('diasDelRango: lista inclusive', () => {
  assert.deepEqual(diasDelRango('2026-11-29', '2026-12-02'), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.deepEqual(diasDelRango('2026-11-10', '2026-11-10'), ['2026-11-10']);
});

// ---- Semanas de lunes a domingo ----
test('lunesDe: lunes a domingo', () => {
  assert.equal(lunesDe('2026-11-09'), '2026-11-09'); // lunes
  assert.equal(lunesDe('2026-11-12'), '2026-11-09'); // jueves
  assert.equal(lunesDe('2026-11-15'), '2026-11-09'); // domingo
  assert.equal(lunesDe('2026-11-16'), '2026-11-16'); // lunes siguiente
});
test('periodoDe: etiqueta del período según la agrupación', () => {
  assert.equal(periodoDe('2026-11-12', 'total'), 'total');
  assert.equal(periodoDe('2026-11-12', 'dia'), '2026-11-12');
  assert.equal(periodoDe('2026-11-12', 'semana'), '2026-W46');
  assert.equal(periodoDe('2026-11-12', 'mes'), '2026-11');
  // semanas ISO en el cambio de año: el domingo 3/1/2027 todavía es de la semana 53 de 2026
  assert.equal(periodoDe('2027-01-03', 'semana'), '2026-W53');
  assert.equal(periodoDe('2027-01-04', 'semana'), '2027-W01');
  assert.equal(periodoDe('2026-01-01', 'semana'), '2026-W01');
});
test('periodosDelRango: una semana parcial usa solo los días dentro del rango', () => {
  // del jueves 12 al martes 17: semana 46 (jue-dom) y semana 47 (lun-mar)
  assert.deepEqual(periodosDelRango('2026-11-12', '2026-11-17', 'semana'), [
    { periodo: '2026-W46', desde: '2026-11-12', hasta: '2026-11-15' },
    { periodo: '2026-W47', desde: '2026-11-16', hasta: '2026-11-17' },
  ]);
});
test('periodosDelRango: mes, día y total', () => {
  assert.deepEqual(periodosDelRango('2026-11-28', '2026-12-02', 'mes'), [
    { periodo: '2026-11', desde: '2026-11-28', hasta: '2026-11-30' },
    { periodo: '2026-12', desde: '2026-12-01', hasta: '2026-12-02' },
  ]);
  assert.deepEqual(periodosDelRango('2026-11-10', '2026-11-11', 'dia'), [
    { periodo: '2026-11-10', desde: '2026-11-10', hasta: '2026-11-10' },
    { periodo: '2026-11-11', desde: '2026-11-11', hasta: '2026-11-11' },
  ]);
  assert.deepEqual(periodosDelRango('2026-11-10', '2026-11-30', 'total'), [{ periodo: 'total', desde: '2026-11-10', hasta: '2026-11-30' }]);
});
test('periodosDelRango: agrupación inválida', () => {
  assert.throws(() => periodosDelRango('2026-11-10', '2026-11-30', 'año'), /agrupar/i);
});

// ---- Días sin cierre (RN-C7) ----
const c = (fecha, tipo = 'trabajado') => ({ fecha, tipo });
test('días sin cierre: faltan 11, 12, 13 y 15; el 16 (hoy) no se cuenta', () => {
  const r = diasSinCierre({ cierres: [c('2026-11-10'), c('2026-11-14')], desde: '2026-11-10', hasta: '2026-11-16', hoy: '2026-11-16' });
  assert.deepEqual(r, ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-15']);
});
test('días sin cierre: un día no trabajado cuenta como cerrado', () => {
  const r = diasSinCierre({ cierres: [c('2026-11-10'), c('2026-11-11', 'no_trabajado'), c('2026-11-14')], desde: '2026-11-10', hasta: '2026-11-16', hoy: '2026-11-16' });
  assert.deepEqual(r, ['2026-11-12', '2026-11-13', '2026-11-15']);
});
test('días sin cierre: sin ningún cierre no hay avisos', () => {
  assert.deepEqual(diasSinCierre({ cierres: [], desde: '2026-11-01', hasta: '2026-11-16', hoy: '2026-11-16' }), []);
});
test('días sin cierre: no se cuentan los días anteriores al primer cierre', () => {
  const r = diasSinCierre({ cierres: [c('2026-11-12')], desde: '2026-11-01', hasta: '2026-11-15', hoy: '2026-11-16' });
  assert.deepEqual(r, ['2026-11-13', '2026-11-14', '2026-11-15']);
});
test('días sin cierre: el primer cierre puede ser anterior al rango pedido', () => {
  const r = diasSinCierre({ cierres: [c('2026-10-01'), c('2026-11-14')], desde: '2026-11-12', hasta: '2026-11-14', hoy: '2026-11-16' });
  assert.deepEqual(r, ['2026-11-12', '2026-11-13']);
});
test('días sin cierre: ayer sin cargar se avisa, hoy no', () => {
  const r = diasSinCierre({ cierres: [c('2026-11-14')], desde: '2026-11-14', hasta: '2026-11-16', hoy: '2026-11-16' });
  assert.deepEqual(r, ['2026-11-15']);
});
test('fin de temporada: los días posteriores no se avisan', () => {
  const r = diasSinCierre({ cierres: [c('2026-03-01'), c('2026-03-10', 'fin_temporada')], desde: '2026-03-01', hasta: '2026-03-20', hoy: '2026-03-20' });
  assert.deepEqual(r, ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09']);
});
test('fin de temporada: al cargar un cierre en la temporada siguiente vuelven a exigirse los diarios', () => {
  const r = diasSinCierre({
    cierres: [c('2026-03-09'), c('2026-03-10', 'fin_temporada'), c('2026-11-10'), c('2026-11-12')],
    desde: '2026-03-09', hasta: '2026-11-13', hoy: '2026-11-14',
  });
  assert.deepEqual(r, ['2026-11-11', '2026-11-13']);
});
test('fin de temporada: sin ese cierre (eliminado) vuelven los avisos', () => {
  const r = diasSinCierre({ cierres: [c('2026-03-01')], desde: '2026-03-01', hasta: '2026-03-04', hoy: '2026-03-05' });
  assert.deepEqual(r, ['2026-03-02', '2026-03-03', '2026-03-04']);
});

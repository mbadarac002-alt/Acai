// T11 · Cálculo en vivo de la pantalla de caja. Debe dar exactamente lo mismo que el servidor (que es quien guarda).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = require('../public/static/caja-calculo.js');
const srv = require('../src/caja-reglas');

test('la pantalla calcula igual que el servidor en muchos casos', () => {
  const montos = [0, 100, 500000, 123456, 3000000];
  const precios = [[400000, 450000], [500000, 550000], [123450, 99999]];
  let casos = 0;
  for (const fondoInicial of montos) for (const gastos of montos) for (const efectivoContado of montos)
    for (const bowlsEfectivo of [0, 1, 7, 25]) for (const bowlsTransferencia of [0, 3, 40])
      for (const [precioEfectivo, precioTransferencia] of precios) {
        const e = { fondoInicial, bowlsEfectivo, bowlsTransferencia, precioEfectivo, precioTransferencia, gastos, efectivoContado };
        assert.deepEqual(ui.calcularCierre(e), srv.calcularCierre(e), JSON.stringify(e));
        casos++;
      }
  assert.ok(casos > 1000);
});

test('ejemplo del spec: 5.000 + 20.000 − 3.000 = 22.000 esperados', () => {
  const c = ui.calcularCierre({ fondoInicial: 500000, bowlsEfectivo: 5, bowlsTransferencia: 2, precioEfectivo: 400000, precioTransferencia: 450000, gastos: 300000, efectivoContado: 2150000 });
  assert.equal(c.efectivoEsperado, 2200000);
  assert.equal(c.diferencia, -50000);
  assert.equal(c.ventas, 2900000);
  assert.equal(c.utilidad, 2600000);
});

test('conversión de pesos a centavos igual que el servidor', () => {
  for (const v of [0, 1, 4000, 1234.56, '2500.5', 0.1 + 0.2, '12.345']) assert.equal(ui.aCentavos(v), srv.aCentavos(v), String(v));
});

test('precio vigente en una fecha igual que el servidor', () => {
  const historial = [
    { vigente_desde: '2026-11-15', precio_efectivo: 500000, precio_transferencia: 550000 },
    { vigente_desde: '2026-11-01', precio_efectivo: 400000, precio_transferencia: 450000 },
  ];
  for (const f of ['2026-10-31', '2026-11-01', '2026-11-14', '2026-11-15', '2026-12-01']) {
    assert.deepEqual(ui.precioVigente(historial, f), srv.precioVigente(historial, f), f);
  }
  assert.equal(ui.precioVigente([], '2026-11-15'), null);
});

test('clase de la diferencia: cero, faltante o sobrante', () => {
  assert.equal(ui.claseDiferencia(0), 'dif-ok');
  assert.equal(ui.claseDiferencia(-50000), 'dif-falta');
  assert.equal(ui.claseDiferencia(100), 'dif-sobra');
});

test('los archivos JavaScript de la pantalla de caja no tienen errores de sintaxis', () => {
  const dir = path.join(__dirname, '..', 'public', 'static');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }), f);
  }
});

// ---- T12 · totales del listado de gastos generales ----
test('resumen de gastos: cantidad, total, stock y corrientes; los eliminados no cuentan', () => {
  const lista = [
    { monto: 150000, tipo: 'stock', eliminado_en: null },
    { monto: 30000.5, tipo: 'stock', eliminado_en: null },
    { monto: 20000, tipo: 'corriente', eliminado_en: null },
    { monto: 999, tipo: 'corriente', eliminado_en: '2026-11-10 10:00' },
  ];
  assert.deepEqual(ui.resumirGastos(lista), { cantidad: 3, total: 20000050, stock: 18000050, corrientes: 2000000, eliminados: 1 });
});

test('resumen de gastos: lista vacía y centavos sin errores de coma flotante', () => {
  assert.deepEqual(ui.resumirGastos([]), { cantidad: 0, total: 0, stock: 0, corrientes: 0, eliminados: 0 });
  const r = ui.resumirGastos([{ monto: 0.1, tipo: 'corriente', eliminado_en: null }, { monto: 0.2, tipo: 'corriente', eliminado_en: null }]);
  assert.equal(r.total, 30);
});

test('las pestañas principales del panel no capturan los botones de las vistas internas de Caja', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  // los botones de las vistas de Caja también están dentro de un contenedor .tabs: el cambio de pestaña principal
  // tiene que limitarse a los botones que tienen data-tab, o al tocar una vista se ocultaría toda la pestaña
  assert.ok(!/querySelectorAll\('\.tabs button'\)/.test(html), "usar querySelectorAll('.tabs button[data-tab]')");
  assert.match(html, /querySelectorAll\('\.tabs button\[data-tab\]'\)/);
});

// ---- T13 · fechas, etiquetas y atajos de rango del resumen ----
const reglas = require('../src/reglas');

test('sumarDias y lunesDe de la pantalla dan lo mismo que los del servidor', () => {
  let f = '2025-12-20';
  for (let i = 0; i < 80; i++) {
    assert.equal(ui.sumarDias(f, 1), reglas.sumarDias(f, 1), f);
    assert.equal(ui.sumarDias(f, -35), reglas.sumarDias(f, -35), f);
    assert.equal(ui.lunesDe(f), srv.lunesDe(f), f);
    f = reglas.sumarDias(f, 1);
  }
});

test('día corto: día de la semana y fecha con año de dos cifras', () => {
  assert.equal(ui.diaCorto('2025-11-12'), 'mié 12/11/25');
  assert.equal(ui.diaCorto('2026-01-03'), 'sáb 03/01/26');
});

test('etiqueta de un período: día, semana (con sus límites reales), mes y total', () => {
  assert.equal(ui.etiquetaPeriodo({ periodo: '2025-11-12', desde: '2025-11-12', hasta: '2025-11-12' }, 'dia'), 'mié 12/11/25');
  assert.equal(ui.etiquetaPeriodo({ periodo: '2025-W46', desde: '2025-11-10', hasta: '2025-11-16' }, 'semana'), 'Sem. 46 · 10/11 al 16/11');
  assert.equal(ui.etiquetaPeriodo({ periodo: '2025-W49', desde: '2025-12-01', hasta: '2025-12-03' }, 'semana'), 'Sem. 49 · 01/12 al 03/12', 'semana parcial');
  assert.equal(ui.etiquetaPeriodo({ periodo: '2025-W47', desde: '2025-11-17', hasta: '2025-11-17' }, 'semana'), 'Sem. 47 · 17/11');
  assert.equal(ui.etiquetaPeriodo({ periodo: '2025-11', desde: '2025-11-10', hasta: '2025-11-30' }, 'mes'), 'noviembre 2025');
  assert.equal(ui.etiquetaPeriodo({ periodo: '2026-03', desde: '2026-03-01', hasta: '2026-03-31' }, 'mes'), 'marzo 2026');
  assert.equal(ui.etiquetaPeriodo({ periodo: 'total', desde: '2025-11-01', hasta: '2025-11-30' }, 'total'), 'Total del rango');
});

test('atajos de rango: hoy, esta semana (desde el lunes), este mes y últimos 30 días', () => {
  assert.deepEqual(ui.rangoPreset('hoy', '2025-11-12'), { desde: '2025-11-12', hasta: '2025-11-12' });
  assert.deepEqual(ui.rangoPreset('semana', '2025-11-12'), { desde: '2025-11-10', hasta: '2025-11-12' });
  assert.deepEqual(ui.rangoPreset('semana', '2025-11-10'), { desde: '2025-11-10', hasta: '2025-11-10' }, 'hoy es lunes');
  assert.deepEqual(ui.rangoPreset('semana', '2025-11-16'), { desde: '2025-11-10', hasta: '2025-11-16' }, 'hoy es domingo');
  assert.deepEqual(ui.rangoPreset('mes', '2025-11-12'), { desde: '2025-11-01', hasta: '2025-11-12' });
  assert.deepEqual(ui.rangoPreset('30dias', '2025-11-12'), { desde: '2025-10-14', hasta: '2025-11-12' });
  assert.throws(() => ui.rangoPreset('otro', '2025-11-12'));
});

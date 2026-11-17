// T4 · Crear y listar cierres de caja (spec 9.3 RN-C3, 9.5 y criterios de 9.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acai-cierres-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.OWNER_EMAIL = 'dueno@example.com';
const app = require('../src/server');
const { ahoraLocal, sumarDias } = require('../src/reglas');
const { db } = require('../src/db');

let base, server;
const auth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const adm = (url, method = 'GET', body) => fetch(base + '/api/admin' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body && JSON.stringify(body) });
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });

const hoy = ahoraLocal().fecha;
const cfgBase = { precio_balde: 1000, umbral_baldes: 10, descuento_pct: 15, hora_corte: '12:00', email_propietario: 'dueno@example.com' };
const precios = (efectivo, transferencia, desde) => adm('/config', 'PUT', { ...cfgBase, precio_bowl_efectivo: efectivo, precio_bowl_transferencia: transferencia, precio_bowl_desde: desde });
const crear = (body) => adm('/caja/cierres', 'POST', body);
const trabajado = (fecha, over = {}) => ({
  punto_venta_id: 1, fecha, tipo: 'trabajado', fondo_inicial: 0, bowls_efectivo: 1, bowls_transferencia: 1, gastos: 0, efectivo_contado: 4000, ...over,
});
const contar = () => db.prepare('SELECT COUNT(*) n FROM cierres_caja').get().n;

test('puntos de venta: lista de los tres, y requiere autenticación', async () => {
  const pv = await (await adm('/puntos-venta')).json();
  assert.deepEqual(pv.map(p => p.nombre), ['Miramar 1', 'Miramar 2', 'Chapadmalal']);
  assert.equal((await fetch(base + '/api/admin/puntos-venta')).status, 401);
});

test('sin precios configurados: el día trabajado responde 409; no trabajado y fin de temporada se aceptan', async () => {
  let r = await crear(trabajado('2025-11-01', { punto_venta_id: 3 }));
  assert.equal(r.status, 409);
  assert.match((await r.json()).errores.join(' '), /precio del bowl/i);
  assert.equal(contar(), 0);

  r = await crear({ punto_venta_id: 3, fecha: '2025-11-01', tipo: 'no_trabajado', motivo: 'lluvia' });
  assert.equal(r.status, 201);

  r = await crear({ punto_venta_id: 2, fecha: '2025-11-01', tipo: 'fin_temporada' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).motivo, 'Fin de temporada');
});

test('día trabajado: ingresos por bowls, esperado 22.000, diferencia 0, ventas y utilidad (ejemplo del spec)', async () => {
  await precios(4000, 4500, '2020-01-01');
  const r = await crear({ punto_venta_id: 1, fecha: '2025-11-02', tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 5, bowls_transferencia: 2, gastos: 3000, nota_gastos: 'hielo y nafta', efectivo_contado: 22000 });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.punto_venta, 'Miramar 1');
  assert.equal(c.ingresos_efectivo, 20000);
  assert.equal(c.ingresos_transferencia, 9000);
  assert.equal(c.efectivo_esperado, 22000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.ventas, 29000);
  assert.equal(c.utilidad_relativa, 26000);
  assert.equal(c.precio_bowl_efectivo, 4000);
  assert.equal(c.precio_bowl_transferencia, 4500);
  assert.equal(c.nota_gastos, 'hielo y nafta');
  assert.equal(c.corregido_en, null);
  assert.equal(c.eliminado_en, null);
  assert.match(c.creado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // en la base, en centavos enteros
  const f = db.prepare("SELECT ingresos_efectivo, efectivo_esperado, precio_bowl_efectivo FROM cierres_caja WHERE fecha = '2025-11-02'").get();
  assert.deepEqual({ ...f }, { ingresos_efectivo: 2000000, efectivo_esperado: 2200000, precio_bowl_efectivo: 400000 });
});

test('faltante: contado 21.500 sin nota responde 400; con nota se guarda con diferencia −500', async () => {
  const body = { punto_venta_id: 1, fecha: '2025-11-03', tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 5, bowls_transferencia: 2, gastos: 3000, efectivo_contado: 21500 };
  const antes = contar();
  let r = await crear(body);
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errores.some(e => /nota/i.test(e)));
  r = await crear({ ...body, nota_diferencia: '   ' });
  assert.equal(r.status, 400, 'una nota en blanco no vale');
  assert.equal(contar(), antes);
  r = await crear({ ...body, nota_diferencia: 'faltó dar un vuelto' });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.diferencia, -500);
  assert.equal(c.nota_diferencia, 'faltó dar un vuelto');
});

test('las transferencias no modifican el efectivo esperado ni la diferencia, pero sí las ventas', async () => {
  const r = await crear({ punto_venta_id: 2, fecha: '2025-11-03', tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 5, bowls_transferencia: 9, gastos: 3000, efectivo_contado: 22000 });
  const c = await r.json();
  assert.equal(c.efectivo_esperado, 22000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.ventas, 20000 + 9 * 4500);
});

test('día trabajado sin ventas (todo en cero, contado igual al fondo) se acepta', async () => {
  const r = await crear({ punto_venta_id: 1, fecha: '2025-11-04', tipo: 'trabajado', fondo_inicial: 5000, bowls_efectivo: 0, bowls_transferencia: 0, gastos: 0, efectivo_contado: 5000 });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.ventas, 0);
  assert.equal(c.efectivo_esperado, 5000);
  assert.equal(c.tipo, 'trabajado');
});

test('día no trabajado: exige motivo, deja los montos en cero y no tiene diferencia', async () => {
  const antes = contar();
  let r = await crear({ punto_venta_id: 1, fecha: '2025-11-05', tipo: 'no_trabajado' });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).errores.some(e => /motivo/i.test(e)));
  r = await crear({ punto_venta_id: 1, fecha: '2025-11-05', tipo: 'no_trabajado', motivo: '  ' });
  assert.equal(r.status, 400);
  assert.equal(contar(), antes);

  // los montos que se manden se ignoran
  r = await crear({ punto_venta_id: 1, fecha: '2025-11-05', tipo: 'no_trabajado', motivo: 'lluvia', fondo_inicial: 999, bowls_efectivo: 7, efectivo_contado: 123 });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.equal(c.motivo, 'lluvia');
  for (const k of ['fondo_inicial', 'bowls_efectivo', 'bowls_transferencia', 'ingresos_efectivo', 'ingresos_transferencia', 'gastos', 'efectivo_esperado', 'efectivo_contado', 'diferencia', 'ventas', 'utilidad_relativa']) {
    assert.equal(c[k], 0, k);
  }
  assert.equal(c.precio_bowl_efectivo, null);
});

test('fin de temporada: el motivo es opcional', async () => {
  let r = await crear({ punto_venta_id: 1, fecha: '2025-11-30', tipo: 'fin_temporada', motivo: 'cerramos por el invierno' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).motivo, 'cerramos por el invierno');
});

test('un solo cierre por punto de venta y fecha, de cualquier tipo (409); eliminado libera la fecha', async () => {
  let r = await crear(trabajado('2025-11-02'));
  assert.equal(r.status, 409);
  assert.match((await r.json()).errores.join(' '), /ya hay un cierre/i);
  r = await crear(trabajado('2025-11-05')); // ya hay uno no trabajado ese día
  assert.equal(r.status, 409);
  // otro punto de venta, misma fecha: permitido
  r = await crear(trabajado('2025-11-05', { punto_venta_id: 2 }));
  assert.equal(r.status, 201);
  // se elimina el primero (borrado lógico) y se acepta uno nuevo
  db.prepare("UPDATE cierres_caja SET eliminado_en = '2025-11-06 10:00', motivo_eliminacion = 'error de carga' WHERE punto_venta_id = 1 AND fecha = '2025-11-02'").run();
  r = await crear(trabajado('2025-11-02'));
  assert.equal(r.status, 201);
});

test('validaciones: valores negativos, bowls no enteros, fecha futura o inválida, tipo inválido y datos faltantes (400)', async () => {
  const antes = contar();
  const f = '2025-12-01';
  const casos = [
    [trabajado(f, { fondo_inicial: -1 }), /fondo/i],
    [trabajado(f, { gastos: -1 }), /gastos/i],
    [trabajado(f, { efectivo_contado: -1 }), /contado/i],
    [trabajado(f, { bowls_efectivo: -1 }), /bowls.*efectivo/i],
    [trabajado(f, { bowls_transferencia: 1.5 }), /bowls.*transferencia/i],
    [trabajado(f, { bowls_efectivo: 'muchos' }), /bowls.*efectivo/i],
    [trabajado(f, { fondo_inicial: 'abc' }), /fondo/i],
    [trabajado(f, { gastos: 5000000000 }), /gastos/i],
    [trabajado(f, { bowls_efectivo: 10000000 }), /bowls.*efectivo/i],
    [trabajado(sumarDias(hoy, 1)), /futura/i],
    [trabajado('2025-02-30'), /inválida/i],
    [trabajado('hoy'), /inválida/i],
    [trabajado(f, { tipo: 'otro' }), /tipo/i],
    [trabajado(f, { tipo: undefined }), /tipo/i],
    [trabajado(f, { punto_venta_id: undefined }), /punto de venta/i],
    [trabajado(f, { punto_venta_id: 'abc' }), /punto de venta/i],
    [{ punto_venta_id: 1, fecha: f, tipo: 'trabajado' }, /fondo/i],
    [trabajado(f, { efectivo_contado: undefined }), /contado/i],
  ];
  for (const [body, patron] of casos) {
    const r = await crear(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const { errores } = await r.json();
    assert.ok(errores.some(e => patron.test(e)), `${JSON.stringify(body)} -> ${errores}`);
  }
  assert.equal(contar(), antes, 'ningún cierre inválido se guarda');
});

test('un cierre de hoy es válido; el de mañana no', async () => {
  assert.equal((await crear({ punto_venta_id: 3, fecha: hoy, tipo: 'no_trabajado', motivo: 'feriado' })).status, 201);
});

test('punto de venta inexistente o inactivo: 404', async () => {
  let r = await crear(trabajado('2025-12-02', { punto_venta_id: 99 }));
  assert.equal(r.status, 404);
  db.prepare('UPDATE puntos_venta SET activo = 0 WHERE id = 3').run();
  r = await crear(trabajado('2025-12-02', { punto_venta_id: 3 }));
  assert.equal(r.status, 404);
  db.prepare('UPDATE puntos_venta SET activo = 1 WHERE id = 3').run();
});

test('cada cierre usa el precio vigente en su fecha, sin importar cuándo se carga', async () => {
  await precios(5000, 5500, '2025-11-15');
  let c = await (await crear(trabajado('2025-11-12', { efectivo_contado: 4000 }))).json();
  assert.equal(c.precio_bowl_efectivo, 4000);
  assert.equal(c.ingresos_efectivo, 4000);
  assert.equal(c.ingresos_transferencia, 4500);
  c = await (await crear(trabajado('2025-11-16', { efectivo_contado: 5000 }))).json();
  assert.equal(c.precio_bowl_efectivo, 5000);
  assert.equal(c.ingresos_transferencia, 5500);
  // el día del cambio ya rige el precio nuevo
  c = await (await crear(trabajado('2025-11-15', { efectivo_contado: 5000 }))).json();
  assert.equal(c.precio_bowl_efectivo, 5000);
});

test('sin precio vigente en esa fecha (anterior al primero) el día trabajado responde 409', async () => {
  const r = await crear(trabajado('2019-12-31'));
  assert.equal(r.status, 409);
  assert.match((await r.json()).errores.join(' '), /precio del bowl/i);
  // un día no trabajado no necesita precio
  assert.equal((await crear({ punto_venta_id: 1, fecha: '2019-12-31', tipo: 'no_trabajado', motivo: 'sin actividad' })).status, 201);
});

test('cambiar los precios después no modifica los cierres ya cargados', async () => {
  await precios(9000, 9500, '2025-11-01');
  const lista = await (await adm('/caja/cierres?desde=2025-11-12&hasta=2025-11-12')).json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].ingresos_efectivo, 4000);
  assert.equal(lista[0].precio_bowl_efectivo, 4000);
});

test('listado: orden por fecha descendente, con ventas y utilidad de cada cierre', async () => {
  const lista = await (await adm('/caja/cierres')).json();
  const fechas = lista.map(c => c.fecha);
  assert.deepEqual(fechas, [...fechas].sort().reverse());
  const c = lista.find(x => x.fecha === '2025-11-03' && x.punto_venta_id === 1);
  assert.equal(c.punto_venta, 'Miramar 1');
  assert.equal(c.ventas, 29000);
  assert.equal(c.utilidad_relativa, 26000);
  assert.equal(c.diferencia, -500);
});

test('listado: filtros por rango de fechas y por punto de venta', async () => {
  let l = await (await adm('/caja/cierres?punto_venta_id=2')).json();
  assert.ok(l.length > 0 && l.every(c => c.punto_venta_id === 2));
  l = await (await adm('/caja/cierres?desde=2025-11-12&hasta=2025-11-16')).json();
  assert.deepEqual(l.map(c => c.fecha).sort(), ['2025-11-12', '2025-11-15', '2025-11-16']);
  l = await (await adm('/caja/cierres?desde=2025-11-16')).json();
  assert.ok(l.every(c => c.fecha >= '2025-11-16'));
});

test('listado: los eliminados no se ven salvo con el filtro', async () => {
  db.prepare("UPDATE cierres_caja SET eliminado_en = '2025-11-20 10:00', motivo_eliminacion = 'duplicado' WHERE punto_venta_id = 1 AND fecha = '2025-11-04'").run();
  const activos = await (await adm('/caja/cierres')).json();
  assert.ok(!activos.some(c => c.punto_venta_id === 1 && c.fecha === '2025-11-04'));
  const solo = await (await adm('/caja/cierres?eliminados=solo')).json();
  assert.ok(solo.every(c => c.eliminado_en));
  assert.ok(solo.some(c => c.punto_venta_id === 1 && c.fecha === '2025-11-04' && c.motivo_eliminacion === 'duplicado'));
  const todos = await (await adm('/caja/cierres?eliminados=todos')).json();
  assert.equal(todos.length, activos.length + solo.length);
});

test('listado: filtros inválidos responden 400', async () => {
  for (const q of ['eliminados=x', 'desde=2025-13-01', 'desde=2025-11-10&hasta=2025-11-01', 'punto_venta_id=abc']) {
    assert.equal((await adm('/caja/cierres?' + q)).status, 400, q);
  }
});

test('los cierres requieren autenticación', async () => {
  assert.equal((await fetch(base + '/api/admin/caja/cierres')).status, 401);
  const r = await fetch(base + '/api/admin/caja/cierres', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

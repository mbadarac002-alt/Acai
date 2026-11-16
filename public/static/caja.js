// Pestaña "Caja" del panel (spec 9.6). Por ahora: cierre diario. Los totales en vivo son solo una vista previa
// (CajaCalculo); quien valida y guarda es el servidor, y sus mensajes de error se muestran tal cual.
window.Caja = (function () {
  const C = window.CajaCalculo;
  let d = null;            // dependencias del panel: { api, $, pesos, ddmm, irAConfiguracion }
  let puntos = [];         // puntos de venta
  let precios = [];        // historial de precios del bowl (en pesos), del más reciente al más antiguo
  let editando = null;     // cierre que se está corrigiendo (null = alta)
  let temporizador;

  const el = id => document.getElementById(id);
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const diaSemana = iso => DIAS[new Date(iso + 'T12:00:00').getDay()];
  const ddmmaa = iso => iso.split('-').reverse().join('/');
  const fechaLocal = () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  };
  const centavosAPesos = c => d.pesos(c / 100);
  const pesosConSigno = n => (n < 0 ? '-' : '') + d.pesos(Math.abs(n));  // -$500,00 en lugar de $-500,00

  function mensaje(contenedor, clase, contenido) {
    contenedor.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'msg ' + clase;
    if (Array.isArray(contenido) && contenido.length > 1) {
      const ul = document.createElement('ul');
      contenido.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      box.appendChild(ul);
    } else box.textContent = Array.isArray(contenido) ? contenido[0] : contenido;
    contenedor.appendChild(box);
  }
  const erroresDe = e => (Array.isArray(e) ? e : ['No se pudo completar la operación. Revisá la conexión e intentá de nuevo.']);

  // ---- Diálogo de motivo (eliminaciones) ----
  function pedirMotivo({ titulo, detalle, boton }) {
    const dlg = el('dlgMotivo'), txt = el('motivoTexto');
    el('motivoTitulo').textContent = titulo;
    el('motivoDetalle').textContent = detalle;
    el('motivoConfirmar').textContent = boton || 'Eliminar';
    el('motivoMsg').innerHTML = '';
    txt.value = '';
    return new Promise(resolve => {
      let resultado = null;
      el('motivoCancelar').onclick = () => dlg.close();
      el('formMotivo').onsubmit = e => {
        e.preventDefault();
        const v = txt.value.trim();
        if (!v) { mensaje(el('motivoMsg'), 'error', 'Indicá el motivo.'); return; }
        resultado = v; dlg.close();
      };
      dlg.onclose = () => resolve(resultado);
      dlg.showModal(); txt.focus();
    });
  }

  // ---- Formulario de cierre ----
  const tipo = () => document.querySelector('input[name="c_tipo"]:checked').value;
  const num = id => { const v = el(id).value.trim(); return v === '' ? null : Number(v); };
  const monto = id => C.aCentavos(num(id) ?? 0);

  function setTipo(t) {
    document.querySelectorAll('input[name="c_tipo"]').forEach(r => { r.checked = r.value === t; });
  }

  /** Precio del bowl que usará el cierre: el que ya tenía (si se corrige sin cambiar la fecha) o el vigente en la fecha. */
  function precioActual() {
    const fecha = el('c_fecha').value;
    if (editando && editando.tipo === 'trabajado' && editando.precio_bowl_efectivo != null && editando.fecha === fecha) {
      return { precioEfectivo: C.aCentavos(editando.precio_bowl_efectivo), precioTransferencia: C.aCentavos(editando.precio_bowl_transferencia) };
    }
    const v = C.precioVigente(precios.map(p => ({
      vigente_desde: p.vigente_desde, precio_efectivo: C.aCentavos(p.precio_efectivo), precio_transferencia: C.aCentavos(p.precio_transferencia),
    })), fecha);
    return v ? { precioEfectivo: v.precio_efectivo, precioTransferencia: v.precio_transferencia } : null;
  }

  const CLAVES = ['k_precios', 'k_ventas_ef', 'k_ventas_tr', 'k_ventas', 'k_esperado', 'k_dif', 'k_utilidad'];
  function limpiarCalculo() { CLAVES.forEach(k => { el(k).textContent = '—'; }); el('k_dif').className = 'grande'; }

  function recalcular() {
    const aviso = el('cierreSinPrecios');
    document.querySelectorAll('#c_tipo label').forEach(l => l.classList.toggle('activo', l.querySelector('input').checked));
    const t = tipo();
    el('c_trabajado').hidden = t !== 'trabajado';
    el('c_motivo_box').hidden = t === 'trabajado';
    el('c_motivo_label').textContent = t === 'no_trabajado' ? 'Motivo (obligatorio)' : 'Motivo (opcional)';
    if (t !== 'trabajado') { aviso.hidden = true; return; }

    const p = precioActual();
    if (!p) {
      limpiarCalculo();
      el('c_nota_dif_box').hidden = true;
      aviso.hidden = false; aviso.textContent = '';
      aviso.append(`No hay un precio del bowl cargado para el ${el('c_fecha').value ? ddmmaa(el('c_fecha').value) : 'día elegido'}. Cargalo en `);
      const a = document.createElement('a'); a.href = '#'; a.textContent = 'Configuración';
      a.addEventListener('click', ev => { ev.preventDefault(); d.irAConfiguracion(); });
      aviso.append(a, ' (con la fecha desde la que rige) antes de guardar un día trabajado.');
      return;
    }
    aviso.hidden = true;

    const bE = num('c_bowls_ef') ?? 0, bT = num('c_bowls_tr') ?? 0;
    const contadoIngresado = num('c_contado') !== null;
    const r = C.calcularCierre({
      fondoInicial: monto('c_fondo'), bowlsEfectivo: bE, bowlsTransferencia: bT, precioEfectivo: p.precioEfectivo,
      precioTransferencia: p.precioTransferencia, gastos: monto('c_gastos'), efectivoContado: monto('c_contado'),
    });
    el('k_precios').textContent = `${centavosAPesos(p.precioEfectivo)} efectivo · ${centavosAPesos(p.precioTransferencia)} transf.`;
    el('k_ventas_ef').textContent = centavosAPesos(r.ingresosEfectivo);
    el('k_ventas_tr').textContent = centavosAPesos(r.ingresosTransferencia);
    el('k_ventas').textContent = centavosAPesos(r.ventas);
    el('k_esperado').textContent = centavosAPesos(r.efectivoEsperado);
    el('k_utilidad').textContent = centavosAPesos(r.utilidad);
    if (contadoIngresado) {
      el('k_dif').textContent = r.diferencia === 0 ? '$0,00 · coincide'
        : (r.diferencia < 0 ? 'Faltan ' : 'Sobran ') + centavosAPesos(Math.abs(r.diferencia));
      el('k_dif').className = 'grande ' + C.claseDiferencia(r.diferencia);
    } else { el('k_dif').textContent = '—'; el('k_dif').className = 'grande'; }
    el('c_nota_dif_box').hidden = !(contadoIngresado && r.diferencia !== 0);
  }

  function limpiarDatos() {
    ['c_fondo', 'c_bowls_ef', 'c_bowls_tr', 'c_gastos', 'c_contado', 'c_nota_gastos', 'c_nota_dif', 'c_motivo'].forEach(i => { el(i).value = ''; });
  }

  function salirDeCorreccion() {
    editando = null;
    el('cierreTitulo').textContent = 'Cargar cierre del día';
    el('cierreGuardar').textContent = 'Guardar cierre';
    el('cierreCancelar').hidden = true;
  }

  function cancelarCorreccion() {
    salirDeCorreccion(); limpiarDatos(); setTipo('trabajado');
    el('cierreMsg').innerHTML = '';
    recalcular();
  }

  function corregir(c) {
    editando = c;
    el('cierreMsg').innerHTML = '';
    el('cierreTitulo').textContent = `Corregir cierre del ${ddmmaa(c.fecha)} · ${c.punto_venta}`;
    el('cierreGuardar').textContent = 'Guardar corrección';
    el('cierreCancelar').hidden = false;
    limpiarDatos();
    el('c_pv').value = c.punto_venta_id;
    el('c_fecha').value = c.fecha;
    setTipo(c.tipo);
    if (c.tipo === 'trabajado') {
      el('c_fondo').value = c.fondo_inicial; el('c_bowls_ef').value = c.bowls_efectivo; el('c_bowls_tr').value = c.bowls_transferencia;
      el('c_gastos').value = c.gastos; el('c_contado').value = c.efectivo_contado;
      el('c_nota_gastos').value = c.nota_gastos; el('c_nota_dif').value = c.nota_diferencia;
    } else el('c_motivo').value = c.motivo;
    recalcular();
    el('cierreTitulo').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function guardar(ev) {
    ev.preventDefault();
    const t = tipo();
    const body = { punto_venta_id: el('c_pv').value, fecha: el('c_fecha').value, tipo: t };
    if (t === 'trabajado') {
      Object.assign(body, {
        fondo_inicial: el('c_fondo').value, bowls_efectivo: el('c_bowls_ef').value, bowls_transferencia: el('c_bowls_tr').value,
        gastos: el('c_gastos').value, nota_gastos: el('c_nota_gastos').value, efectivo_contado: el('c_contado').value,
        nota_diferencia: el('c_nota_dif_box').hidden ? '' : el('c_nota_dif').value,
      });
    } else body.motivo = el('c_motivo').value;

    const era = editando;
    const btn = el('cierreGuardar');
    btn.disabled = true;
    try {
      const c = await d.api(era ? '/caja/cierres/' + era.id : '/caja/cierres', { method: era ? 'PUT' : 'POST', body: JSON.stringify(body) });
      salirDeCorreccion(); limpiarDatos(); setTipo('trabajado'); recalcular();
      const resumen = c.tipo === 'trabajado'
        ? `: ventas ${d.pesos(c.ventas)}, esperado ${d.pesos(c.efectivo_esperado)}, diferencia ${pesosConSigno(c.diferencia)}.` : '.';
      mensaje(el('cierreMsg'), 'ok', `${era ? 'Cierre corregido' : 'Cierre guardado'} (${c.punto_venta}, ${ddmmaa(c.fecha)})${resumen}`);
      cargarLista();
    } catch (e) {
      mensaje(el('cierreMsg'), 'error', erroresDe(e));
    } finally { btn.disabled = false; }
  }

  // ---- Listado ----
  function tdl(etiqueta, texto, clase) {
    const c = document.createElement('td');
    c.dataset.label = etiqueta; c.textContent = texto;
    if (clase) c.className = clase;
    return c;
  }
  const textoDia = c => c.tipo === 'trabajado' ? 'Trabajó'
    : c.tipo === 'no_trabajado' ? 'No trabajó: ' + c.motivo
      : 'Fin de temporada' + (c.motivo && c.motivo !== 'Fin de temporada' ? ': ' + c.motivo : '');

  function filaCierre(c) {
    const tr = document.createElement('tr');
    if (c.eliminado_en) tr.className = 'eliminado';
    tr.appendChild(tdl('Fecha', `${diaSemana(c.fecha)} ${c.fecha.slice(8)}/${c.fecha.slice(5, 7)}/${c.fecha.slice(2, 4)}`));
    tr.appendChild(tdl('Punto de venta', c.punto_venta));
    const dia = tdl('Día', textoDia(c), 'ancho-texto');
    if (c.corregido_en) { const n = document.createElement('div'); n.className = 'nota'; n.textContent = 'Corregido el ' + d.ddmm(c.corregido_en); dia.appendChild(n); }
    tr.appendChild(dia);
    if (c.tipo === 'trabajado') {
      tr.appendChild(tdl('Bowls (efectivo + transf.)', `${c.bowls_efectivo} + ${c.bowls_transferencia}`, 'num'));
      tr.appendChild(tdl('Ventas', d.pesos(c.ventas), 'num'));
      tr.appendChild(tdl('Gastos', d.pesos(c.gastos), 'num'));
      tr.appendChild(tdl('Esperado', d.pesos(c.efectivo_esperado), 'num'));
      tr.appendChild(tdl('Contado', d.pesos(c.efectivo_contado), 'num'));
      const dif = tdl('Diferencia', pesosConSigno(c.diferencia), 'num ' + C.claseDiferencia(C.aCentavos(c.diferencia)));
      if (c.nota_diferencia) { const n = document.createElement('div'); n.className = 'nota'; n.textContent = c.nota_diferencia; dif.appendChild(n); dif.classList.add('ancho-texto'); }
      tr.appendChild(dif);
      tr.appendChild(tdl('Utilidad', d.pesos(c.utilidad_relativa), 'num'));
    } else {
      for (let i = 0; i < 7; i++) tr.appendChild(tdl('', '—', 'num vacio-celda'));
    }
    const acc = document.createElement('td');
    acc.className = 'acciones-fila';
    if (c.eliminado_en) {
      acc.textContent = `Eliminado el ${d.ddmm(c.eliminado_en)}: ${c.motivo_eliminacion}`;
      acc.classList.add('nota');
    } else {
      const bc = document.createElement('button'); bc.type = 'button'; bc.className = 'secundario'; bc.textContent = 'Corregir';
      bc.addEventListener('click', () => corregir(c));
      const be = document.createElement('button'); be.type = 'button'; be.className = 'peligro'; be.textContent = 'Eliminar';
      be.addEventListener('click', () => eliminar(c));
      acc.append(bc, be);
    }
    tr.appendChild(acc);
    return tr;
  }

  async function eliminar(c) {
    const motivo = await pedirMotivo({
      titulo: 'Eliminar cierre',
      detalle: `${c.punto_venta} · ${ddmmaa(c.fecha)}. Dejará de contarse en los resúmenes y la fecha quedará libre para cargarlo de nuevo.`,
    });
    if (!motivo) return;
    try {
      await d.api('/caja/cierres/' + c.id, { method: 'DELETE', body: JSON.stringify({ motivo }) });
      if (editando && editando.id === c.id) cancelarCorreccion();
      cargarLista();
    } catch (e) { alert(erroresDe(e).join('\n')); cargarLista(); }
  }

  async function cargarLista() {
    const params = new URLSearchParams();
    new FormData(el('cierresFiltros')).forEach((v, k) => { if (String(v).trim()) params.set(k, v); });
    const msg = el('cierresFiltrosMsg'); msg.innerHTML = '';
    let filas;
    try { filas = await d.api('/caja/cierres' + (params.toString() ? '?' + params : '')); }
    catch (e) { mensaje(msg, 'error', erroresDe(e)); return; }
    const tb = el('cierres'); tb.innerHTML = '';
    el('cierresVacio').hidden = filas.length > 0;
    filas.forEach(c => tb.appendChild(filaCierre(c)));
  }

  // ---- Datos base y arranque ----
  function llenarSelect(select, opciones, primera) {
    const actual = select.value;
    select.innerHTML = '';
    if (primera) select.add(new Option(primera, ''));
    opciones.forEach(p => select.add(new Option(p.nombre, p.id)));
    if ([...select.options].some(o => o.value === actual)) select.value = actual;
  }

  async function cargarBase() {
    [puntos, precios] = await Promise.all([d.api('/puntos-venta'), d.api('/caja/precios')]);
    llenarSelect(el('c_pv'), puntos.filter(p => p.activo));
    llenarSelect(el('cf_pv'), puntos, 'Todos los puntos');
    const hoy = fechaLocal();
    el('c_fecha').max = hoy;
    if (!el('c_fecha').value) el('c_fecha').value = hoy;
  }

  function cambiarVista(vista) {
    document.querySelectorAll('#cajaVistas button').forEach(b => b.classList.toggle('activo', b.dataset.vista === vista));
    ['cierre', 'gastos', 'resumen'].forEach(v => { el('vista-' + v).hidden = v !== vista; });
  }

  async function mostrar() {
    try { await cargarBase(); }
    catch (e) { mensaje(el('cierreMsg'), 'error', erroresDe(e)); return; }
    recalcular();
    cargarLista();
  }

  function iniciar(dependencias) {
    d = dependencias;
    el('c_fecha').value = fechaLocal();
    el('cierreForm').addEventListener('submit', guardar);
    el('cierreCancelar').addEventListener('click', cancelarCorreccion);
    el('cierreForm').addEventListener('input', recalcular);
    el('cierreForm').addEventListener('change', recalcular);
    document.querySelectorAll('#cajaVistas button').forEach(b => b.addEventListener('click', () => cambiarVista(b.dataset.vista)));
    el('cierresFiltros').addEventListener('input', () => { clearTimeout(temporizador); temporizador = setTimeout(cargarLista, 250); });
    el('cierresFiltros').addEventListener('submit', e => e.preventDefault());
  }

  return { iniciar, mostrar };
})();

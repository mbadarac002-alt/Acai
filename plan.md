# Plan de implementación · Módulo de caja

> **Estado: PROVISORIO (v3).** Ajustado a la sección 9 de [spec.md](spec.md) en su versión 3, que sigue pendiente de aprobación. Si el propietario cambia algo del spec, se ajustan las tareas afectadas. Nada de este plan está implementado.

Metodología: Specification Driven Development. Cada tarea sigue el mismo ciclo: **primero el test** que expresa el criterio de aceptación, **después el código**, y se corren todos los tests (`npm test`) antes de pasar a la siguiente. No se hacen commits sin que el propietario del repositorio lo pida.

**Decisión de estructura (a confirmar):** el código de caja va en archivos nuevos, `src/caja-reglas.js` (reglas puras, testeables) y `src/caja.js` (rutas y acceso a datos), para no seguir engordando `src/server.js`, que hoy mezcla rutas, reglas y SQL.

## Fase A · Base

| # | Tarea | Terminada cuando |
|---|---|---|
| T1 | Tablas `puntos_venta`, `precios_bowl`, `cierres_caja` (con `tipo`, bowls y precios guardados), `categorias_gasto` y `gastos_generales`, con la carga inicial de los 3 puntos de venta y las 7 categorías | Una base creada antes del módulo arranca sin perder pedidos, clientes ni configuración, y quedan cargados los 3 puntos y las 7 categorías |
| T2 | Funciones puras: pesos↔centavos, precio vigente en una fecha, ingresos por bowls, efectivo esperado y diferencia, ventas y utilidad relativa, semanas de lunes a domingo, días sin cierre (con fin de temporada), validación de fechas y rangos | Tests unitarios con los números del spec (por ejemplo 5 bowls × 4.000 → 20.000; 5.000 + 20.000 − 3.000 = 22.000; utilidad 29.000 − 3.000 = 26.000) |
| T3 | Precios del bowl con vigencia por fecha: `GET`/`PUT /api/admin/config` (precios y "rige desde", opcionales en el PUT), `GET /api/admin/caja/precios` y los campos en el panel de configuración existente | Se agregan al historial y se leen; un precio ≤ 0 o uno solo de los dos da 400; un PUT sin precios no toca el historial y el panel actual sigue funcionando |

## Fase B · Cierres de caja

| # | Tarea | Terminada cuando |
|---|---|---|
| T4 | Crear y listar cierres (`POST` y `GET /api/admin/caja/cierres`), de los tres tipos (trabajado, no trabajado, fin de temporada) | Se cumplen los criterios de 9.7: ingresos calculados con los precios vigentes **en la fecha del cierre**, que quedan guardados, diferencia con nota obligatoria, día no trabajado con motivo, 409 por duplicado o sin precio vigente en esa fecha, 400 por valores negativos, bowls no enteros o fecha futura; el listado trae ventas y utilidad relativa de cada cierre |
| T5 | Corregir y borrar cierres (`PUT` y `DELETE`) | Se recalcula con los precios guardados en el cierre (o los de la nueva fecha si esta cambia); se puede cambiar de tipo; el borrado exige motivo, libera la fecha y el cierre solo se ve con el filtro `eliminados` |

## Fase C · Gastos generales

| # | Tarea | Terminada cuando |
|---|---|---|
| T6 | Crear y listar gastos (`POST` y `GET /api/admin/caja/gastos`) | Validaciones de monto, categoría y fecha; filtros por rango y categoría |
| T7 | Corregir y borrar gastos (`PUT` y `DELETE`) | Igual que T5 |

## Fase D · Resumen

| # | Tarea | Terminada cuando |
|---|---|---|
| T8 | Resumen total (`GET /api/admin/caja/resumen`): mayorista desde pedidos cobrados, minorista con bowls, ventas totales, utilidad relativa, gastos generales y resultado | El resultado coincide con el ejemplo del spec (ventas totales 17.000, utilidad relativa 15.000, resultado 11.000) |
| T9 | Agrupar por día, semana y mes | La suma de ventas, utilidad y resultado de los períodos es igual a la del total del rango |
| T10 | Días sin cierre (con la regla de fin de temporada), días trabajados y no trabajados con su motivo | Se listan los días faltantes por punto de venta (desde su primer cierre hasta ayer) sin bloquear el resultado; los días no trabajados aparecen con su motivo y no figuran como faltantes; **después de un fin de temporada no se avisa ningún día** hasta que se cargue un cierre nuevo de ese punto |

**Punto de control:** antes de tocar la pantalla, se muestra el backend funcionando para que el propietario lo valide.

## Fase E · Panel (pestaña Caja)

| # | Tarea | Terminada cuando |
|---|---|---|
| T11 | Cierre diario: selector de tipo de día (trabajó / no trabajó / fin de temporada), formulario con ventas, efectivo esperado, diferencia y utilidad calculados en vivo, y listado | Se carga un día trabajado, uno no trabajado y un fin de temporada, y se corrige y elimina un cierre desde el navegador |
| T12 | Gastos generales: formulario y listado | Se carga, se corrige y se elimina un gasto desde el navegador |
| T13 | Resumen: rango, agrupación, la cuenta completa hasta el resultado con ventas totales y utilidad relativa destacadas, desglose por unidad y punto de venta, bowls, avisos y días no trabajados | Los números de la pantalla coinciden con los de la API |

## Fase F · Cierre

| # | Tarea | Terminada cuando |
|---|---|---|
| T14 | Verificación contra el spec | Se recorren los criterios de 9.7 uno por uno, marcando cuáles se cumplen y cómo se comprobó |
| T15 | Documentación | `spec.md` pasa de "borrador" a "implementado" (incluida la sección 3, `config`, con las claves nuevas) y el README describe la caja |

## Qué depende de las respuestas del propietario

Ya no queda ninguna pregunta que bloquee el inicio: **T1 puede empezar apenas se apruebe el spec**. Quedan abiertas las de la sección 9.10:

| Pregunta | Efecto en el plan |
|---|---|
| 1. ¿Alcanza con agregar un cambio de precio corregido con la misma fecha, o hay que recalcular cierres ya cargados? | Si hay que recalcular, se agrega una tarea después de T5 |
| 2. ¿Es aceptable que eliminar un pedido cobrado lo saque del resumen de días pasados? | Solo cambia el spec, no el plan |
| 3. ¿Hace falta ver el costo de la mercadería asociado a las ventas? | Si sí, agrega tareas en la Fase D; por ahora no |

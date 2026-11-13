# Plan de implementación · Módulo de caja

> **Estado: PROVISORIO.** Depende de que se apruebe la sección 9 de [spec.md](spec.md) (hoy en borrador). Si el propietario cambia algo del spec, se ajustan las tareas afectadas. Nada de este plan está implementado.

Metodología: Specification Driven Development. Cada tarea sigue el mismo ciclo: **primero el test** que expresa el criterio de aceptación, **después el código**, y se corren todos los tests (`npm test`) antes de pasar a la siguiente. No se hacen commits sin que el propietario del repositorio lo pida.

**Decisión de estructura (a confirmar):** el código de caja va en archivos nuevos, `src/caja-reglas.js` (reglas puras, testeables) y `src/caja.js` (rutas y acceso a datos), para no seguir engordando `src/server.js`, que hoy mezcla rutas, reglas y SQL.

## Fase A · Base

| # | Tarea | Terminada cuando |
|---|---|---|
| T1 | Tablas `puntos_venta`, `cierres_caja`, `categorias_gasto` y `gastos_generales`, con la carga inicial de los 3 puntos de venta y las 7 categorías | Una base creada antes del módulo arranca sin perder pedidos ni clientes, y quedan cargados los 3 puntos y las 7 categorías |
| T2 | Funciones puras: pesos↔centavos, efectivo esperado y diferencia, semanas de lunes a domingo, validación de fechas y rangos | Tests unitarios con los números del spec (por ejemplo 5.000 + 20.000 − 3.000 = 22.000) |

## Fase B · Cierres de caja

| # | Tarea | Terminada cuando |
|---|---|---|
| T3 | Crear y listar cierres (`POST` y `GET /api/admin/caja/cierres`) | Se cumplen los criterios de 9.7: diferencia con nota obligatoria, 409 por duplicado, 400 por montos negativos o fecha futura |
| T4 | Corregir y borrar cierres (`PUT` y `DELETE`) | Se recalcula la diferencia al corregir; el borrado exige motivo, libera la fecha y el cierre solo se ve con el filtro `eliminados` |

## Fase C · Gastos generales

| # | Tarea | Terminada cuando |
|---|---|---|
| T5 | Crear y listar gastos (`POST` y `GET /api/admin/caja/gastos`) | Validaciones de monto, categoría y fecha; filtros por rango y categoría |
| T6 | Corregir y borrar gastos (`PUT` y `DELETE`) | Igual que T4 |

## Fase D · Resumen

| # | Tarea | Terminada cuando |
|---|---|---|
| T7 | Resumen total (`GET /api/admin/caja/resumen`): mayorista desde pedidos cobrados, minorista y gastos generales | El resultado coincide con el ejemplo del spec (5.000 + 12.000 − 2.000 − 4.000 = 11.000) |
| T8 | Agrupar por día, semana y mes | La suma de los resultados de los períodos es igual al resultado del total del rango |
| T9 | Avisos de días sin cierre | Se listan los días faltantes por punto de venta, sin bloquear el resultado |

**Punto de control:** antes de tocar la pantalla, se muestra el backend funcionando para que el propietario lo valide.

## Fase E · Panel (pestaña Caja)

| # | Tarea | Terminada cuando |
|---|---|---|
| T10 | Cierre diario: formulario con efectivo esperado y diferencia calculados en vivo, y listado | Se carga, se corrige y se elimina un cierre desde el navegador |
| T11 | Gastos generales: formulario y listado | Se carga, se corrige y se elimina un gasto desde el navegador |
| T12 | Resumen: rango, agrupación, desglose por unidad y avisos | Los números de la pantalla coinciden con los de la API |

## Fase F · Cierre

| # | Tarea | Terminada cuando |
|---|---|---|
| T13 | Verificación contra el spec | Se recorren los criterios de 9.7 uno por uno, marcando cuáles se cumplen y cómo se comprobó |
| T14 | Documentación | `spec.md` pasa de "borrador" a "implementado" y el README describe la caja |

## Qué depende de las respuestas del propietario

Corresponden a las preguntas abiertas de la sección 9.10 del spec.

| Pregunta | Efecto en el plan |
|---|---|
| 4. ¿Algún gasto del minorista se paga por transferencia? | Cambia la tabla de cierres (hace falta distinguir el medio de pago de los gastos). **Bloquea T1**: conviene tener la respuesta antes de empezar |
| 1. ¿Hay que guardar los valores anteriores al corregir? | Cambia T4 y T6: se agregaría una tabla de historial |
| 3. ¿Hay que definir los días de playa? | Cambia T9: el aviso contaría solo los días que correspondan |
| 2. ¿Es aceptable que eliminar un pedido cobrado lo saque del resumen de días pasados? | Solo cambia el spec, no el plan |

Si el propietario no responde a tiempo, **T2 y la Fase C** se pueden empezar sin riesgo.

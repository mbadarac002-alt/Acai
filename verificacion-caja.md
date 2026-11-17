# Verificación del módulo de caja contra el spec

Se recorrieron uno por uno los criterios de aceptación de la sección 9.7 de [spec.md](spec.md). Estado al momento de la verificación: **186 tests, todos pasan** (`npm test`).

**Resultado: los 41 criterios se cumplen.** Dos de ellos no tenían una prueba directa y se les agregó una (`test/caja-criterios.test.js`); en ambos el comportamiento ya era correcto.

Cada criterio indica el archivo de `test/` y la prueba que lo comprueba.

## Precios del bowl (RN-C2)

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 1 | Sin precios, el día trabajado da 409; no trabajado y fin de temporada se aceptan | ✔ | `caja-cierres`: "sin precios configurados…" |
| 2 | `PUT /config` con precios y fecha de vigencia los agrega al historial; ≤ 0 o uno solo da 400 | ✔ | `caja-precios`: "un cambio de precios con fecha…", "validaciones: precios positivos…" |
| 3 | Un cierre usa el precio vigente en **su fecha**, aunque se cargue después | ✔ | `caja-cierres`: "cada cierre usa el precio vigente en su fecha…" |
| 4 | Un precio nuevo no modifica cierres ya cargados | ✔ | `caja-cierres`: "cambiar los precios después no modifica…" |
| 5 | Al corregir se conservan los precios; si cambia la fecha, se toman los de la fecha nueva | ✔ | `caja-correccion`: "corregir cantidades recalcula con los precios que el cierre ya tenía", "corregir la fecha toma los precios vigentes…" |
| 6 | Primer precio desde el 15/11: el cierre del 10/11 da 409; con vigencia desde el 01/11 se acepta | ✔ (prueba agregada) | `caja-criterios`: "si el primer precio rige desde el 15/11…" |

## Ventas mayoristas (RN-C1)

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 7 | Pedido cobrado con $3.000 + $2.000 suma 5.000 y 1 pedido | ✔ | `caja-resumen`: "mayorista: un pedido cobrado hoy…" |
| 8 | Se cuenta el día del cobro, no el del pedido | ✔ | `caja-resumen`: "mayorista: cuenta en el día del cobro…" |
| 9 | Cobro corregido: montos nuevos y fecha original | ✔ | `caja-resumen`: "mayorista: un pedido cobrado cuyo cobro se corrige…" |
| 10 | Pedido cobrado eliminado deja de sumar | ✔ | `caja-resumen`: "mayorista: un pedido cobrado que se elimina…" |
| 11 | Pedidos no cobrados no suman | ✔ | `caja-resumen`: "mayorista: los pedidos recibidos, en proceso o entregados no suman…" |

## Cierre de caja (RN-C3, RN-C4)

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 12 | Ejemplo 5.000 + 20.000 − 3.000 = 22.000, diferencia 0, ventas 29.000, utilidad 26.000, sin pedir nota | ✔ | `caja-cierres`: "día trabajado: ingresos por bowls…"; `caja-reglas` |
| 13 | Contado 21.500: sin nota 400; con nota se guarda con −500 | ✔ | `caja-cierres`: "faltante: contado 21.500…" |
| 14 | Las transferencias no cambian esperado ni diferencia, sí ventas y utilidad | ✔ | `caja-cierres`: "las transferencias no modifican…" |
| 15 | Día trabajado con ceros se acepta | ✔ | `caja-cierres`: "día trabajado sin ventas…" |
| 16 | No trabajado: con motivo se acepta con montos en cero; sin motivo 400 | ✔ | `caja-cierres`: "día no trabajado: exige motivo…" |
| 17 | Fin de temporada sin motivo se acepta como "Fin de temporada" | ✔ | `caja-cierres`: "sin precios configurados…", "fin de temporada: el motivo es opcional" |
| 18 | Un solo cierre por punto y fecha (409); eliminado libera la fecha | ✔ | `caja-cierres`: "un solo cierre por punto de venta y fecha…"; `caja-db` |
| 19 | Valores negativos, bowls no enteros o fecha futura: 400 y no se guarda nada | ✔ | `caja-cierres`: "validaciones: valores negativos…" |
| 20 | Corregir recalcula, completa `corregido_en` y el resumen usa los valores nuevos | ✔ | `caja-correccion`: "corregir un monto…"; `caja-resumen`: "minorista: un cierre corregido cuenta…" |
| 21 | Corregir a no trabajado pasa los montos a cero | ✔ | `caja-correccion`: "se puede cambiar el tipo…" |
| 22 | Eliminar sin motivo 400; con motivo deja de contar y se ve solo con el filtro | ✔ | `caja-correccion`: "eliminar exige motivo…", "eliminar con motivo…" |

## Gastos generales (RN-C5)

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 23 | $50.000 de mercadería del 28/11 cuentan enteros en noviembre, como stock, y no en diciembre | ✔ | `caja-resumen`: "gastos generales: $50.000 de mercadería…" |
| 24 | Publicidad cuenta como corriente | ✔ | `caja-gastos`: "un gasto de publicidad es corriente…"; `caja-resumen` |
| 25 | Monto ≤ 0, categoría inexistente o fecha futura: 400 | ✔ | `caja-gastos`: "validaciones: monto > 0…" |
| 26 | Gasto eliminado no cuenta | ✔ | `caja-resumen`: "gastos generales: un gasto eliminado no cuenta" |

## Ventas totales, utilidad relativa y resultado (RN-C6)

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 27 | 5.000 + 12.000 − 2.000 − 4.000: ventas 17.000, utilidad 15.000, resultado 11.000 | ✔ | `caja-resumen`: "resultado: mayorista 5.000…"; `caja-reglas`; `caja-resumen-agrupado` (el 12/11) |
| 28 | Semana sin ventas con gasto de $4.000: utilidad 0, resultado −4.000 | ✔ | `caja-resumen`: "resultado: una semana sin ventas…" |
| 29 | `agrupar=dia`: un período por cada día del rango (también vacíos); la suma coincide con el total | ✔ | `caja-resumen-agrupado`: "por día…", "la suma de los períodos es igual al total…" |
| 30 | `agrupar=semana`: lunes a domingo; la semana parcial usa solo los días del rango | ✔ | `caja-resumen-agrupado`: "por semana…" (ambas) |
| 31 | Rango inválido (desde > hasta, > 366 días, fechas mal formadas): 400 | ✔ | `caja-resumen`: "parámetros inválidos responden 400" |

## Días sin cierre (RN-C7)

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 32 | Cierres el 10 y el 14, hoy el 16: avisos 11, 12, 13 y 15; el resultado se calcula igual | ✔ | `caja-avisos`: "faltan 4 días…" |
| 33 | Un día "no trabajó: lluvia" no es aviso y figura en `no_trabajados` con su motivo | ✔ | `caja-avisos`: "un día no trabajado cuenta como cerrado…" |
| 34 | Un punto sin ningún cierre no genera avisos | ✔ | `caja-avisos`: "un punto de venta sin ningún cierre…" |
| 35 | Fin de temporada el 10/03, hoy 20/03: sin avisos del 11 al 19; figura con tipo `fin_temporada` | ✔ | `caja-avisos`: "fin de temporada: los días posteriores no se avisan…" |
| 36 | Un cierre nuevo en noviembre: los días intermedios no se avisan y desde ahí vuelven a exigirse | ✔ | `caja-avisos`: ídem |
| 37 | El fin de temporada de un punto no afecta a los otros | ✔ | `caja-avisos`: "el fin de temporada de un punto de venta no afecta a los otros" |
| 38 | Si se elimina el fin de temporada, vuelven los avisos | ✔ | `caja-avisos`: ídem 35 |

## Seguridad y datos existentes

| # | Criterio | Estado | Cómo se comprobó |
|---|---|---|---|
| 39 | Toda ruta `/api/admin/caja/*` y `/api/admin/puntos-venta` sin credenciales: 401 | ✔ | Una prueba por grupo de rutas en `caja-cierres`, `caja-correccion`, `caja-gastos`, `caja-gastos-correccion`, `caja-precios` y `caja-resumen`; además el control de humo sobre una copia de la base real |
| 40 | Una base creada **antes** de este módulo arranca: crea las tablas, carga puntos y categorías y no cambia pedidos, clientes ni configuración | ✔ (prueba agregada) | `caja-criterios`: "una base creada antes del módulo…"; y sobre una **copia de la base local real** (2 clientes, 4 pedidos): quedaron iguales, más 3 puntos de venta y 7 categorías. La base original no se tocó |
| 41 | `PUT /config` sin los precios del bowl sigue funcionando y no modifica el historial | ✔ | `caja-precios`: "guardar la configuración sin precios del bowl…" |

## Pantalla (sección 9.6)

La pantalla no tiene pruebas automáticas de navegador (el proyecto no usa ese tipo de herramientas). Lo que sí está automatizado: el **cálculo en vivo coincide con el del servidor** (más de mil combinaciones), las fechas, las etiquetas y los atajos de rango, la sintaxis de todos los archivos JavaScript y que los botones de las vistas de Caja no interfieran con las pestañas principales.

El resto se probó a mano en un navegador real durante T11 a T13, con una base de ejemplo:

- Cierre diario: alta con diferencia (error sin nota, guardado con nota), cierre duplicado, corregir con datos precargados, eliminar con motivo, filtro de eliminados, aviso cuando no hay precio.
- Gastos: alta, error de monto, filtro por categoría, totales, corregir, eliminar con motivo.
- Resumen: atajos, total/día/semana/mes, la cuenta completa, avisos, días no trabajados y errores (fecha faltante, rango de más de 366 días).
- Maqueta en celular (360 y 390 px), tablet (820 y 1024 px) y PC (1280 px): sin desbordes, tarjetas en pantallas chicas, controles de 44 px o más.

## Lo que NO se verificó

- **En un celular real.** Se simuló el ancho de pantalla, pero no se probó en un teléfono: teclado numérico, toques y lectura al sol.
- **Despliegue en Railway** (producción): no se publicó nada. Conviene probar la migración sobre una copia de la base de producción antes de unir a `master`.
- **Instalar como aplicación** (agregar a pantalla de inicio): no está implementado ni probado, incluida la contraseña del panel en ese modo.
- **Capturas de pantalla:** la herramienta no funcionó en este entorno; la revisión visual se hizo midiendo y leyendo la página, no mirando la imagen.
- **Uso simultáneo:** dos cargas del mismo cierre a la vez están protegidas por el índice único de la base (responde 409), pero no se probó con dos usuarios reales.

## Ajustes al spec (hechos en T15)

1. La sección 9.8 ahora lista los archivos de prueba reales.
2. Se aclaró que `avisos` incluye solo los puntos de venta con al menos un día sin cierre.
3. Se dejó escrito que `public/static/caja.js` y `caja-calculo.js` se sirven sin clave, como el resto de los estáticos (no contienen datos).
4. El spec pasó de "borrador" a "implementado"; se actualizaron la sección 3 (precios del bowl), la 5, la 7 y la 8, y el README describe la caja.

## Preguntas abiertas del spec (no bloquean)

1. ¿Alcanza con agregar un precio corregido con la misma fecha (que reemplaza al anterior), o hay que poder recalcular cierres ya cargados?
2. ¿Es aceptable que eliminar un pedido mayorista ya cobrado lo saque del resumen de días pasados?
3. ¿Hace falta ver el costo de la mercadería asociado a las ventas (margen real)?
4. Delivery: cuando se defina, se suma como una unidad más.

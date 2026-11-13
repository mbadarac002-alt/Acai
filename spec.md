# Especificación · Açaí Pedidos Mayoristas

Prototipo para recibir y administrar pedidos mayoristas de baldes de açaí.
Este documento describe el comportamiento actual del sistema (derivado del código en `src/`).

## 1. Alcance

**Actores**
- **Cliente:** realiza pedidos desde una página pública, sin cuenta.
- **Propietario:** administra precio, descuentos, estados de pedidos y consulta clientes desde `/admin`.

**Fuera de alcance (prototipo):** pagos online, cuentas de cliente, stock, múltiples productos, edición/cancelación de pedidos, historial de cambios de estado.

## 2. Stack

- Node.js >= 22.13 (usa `node:sqlite`), Express 4, Nodemailer 6.
- Base SQLite en un único archivo (`DB_PATH`, por defecto `data/acai.db`).
- Frontend estático: `public/index.html`, `public/admin.html`, `public/static/styles.css`.

## 3. Modelo de datos

### `clientes`
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | autoincremental |
| dni | TEXT | único, solo dígitos |
| nombre, direccion, telefono | TEXT | obligatorios |
| creado_en | TEXT | `YYYY-MM-DD HH:MM` hora local |

### `pedidos`
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| cliente_id | INTEGER FK | → clientes.id |
| cantidad | INTEGER | baldes pedidos |
| precio_unitario | REAL | precio vigente al momento del pedido |
| subtotal | REAL | cantidad × precio_unitario |
| baldes_acumulados | INTEGER | baldes del cliente en el mes calendario, incluido este pedido |
| descuento_pct, descuento_monto | REAL | 0 si no aplica |
| total | REAL | subtotal − descuento_monto |
| fecha_pedido | TEXT | `YYYY-MM-DD` local |
| creado_en, actualizado_en | TEXT | `YYYY-MM-DD HH:MM` local |
| fecha_entrega | TEXT | `YYYY-MM-DD` |
| estado | TEXT | `recibido` \| `en_proceso` \| `entregado` \| `cobrado` (CHECK). Las bases anteriores se migran al arrancar (se reconstruye la tabla conservando los datos) |
| pago_efectivo, pago_transferencia | REAL | cuánto del total se cobró en efectivo (contado) y por transferencia. Solo tienen valor si `estado = cobrado` (suman exactamente `total`); en otro estado valen 0 |
| cobro_corregido_en | TEXT | `YYYY-MM-DD HH:MM` local de la última corrección de la forma de pago; `NULL` si nunca se corrigió (se agrega por migración) |
| fecha_cobro | TEXT | `YYYY-MM-DD HH:MM` local en que el pedido pasó a `cobrado`; `NULL` en otro estado |
| eliminado_en | TEXT | `NULL` si el pedido está activo; fecha/hora local (`YYYY-MM-DD HH:MM`) en que se lo marcó como eliminado (borrado lógico). Las bases anteriores se migran al arrancar |
| comentarios | TEXT | texto libre del cliente para este pedido; `''` si no escribió nada (hasta 300 caracteres). Las bases anteriores se migran al arrancar |

### `config` (clave/valor)
| Clave | Por defecto | Descripción |
|---|---|---|
| precio_balde | 10000 | precio por balde |
| umbral_baldes | 20 | baldes acumulados en el mes calendario para activar descuento (0 = sin descuento) |
| descuento_pct | 10 | porcentaje de descuento |
| hora_corte | 12:00 | hora límite de los días de entrega (martes y viernes) |
| email_propietario | `OWNER_EMAIL` o vacío | destinatario de notificaciones por mail |
| telegram_chat_id | vacío | ID de chat de Telegram del propietario (número; negativo si es un grupo) |
| canal_notificacion | `mail` | `mail`, `telegram` o `ambos` (un valor guardado inexistente, como el antiguo `whatsapp`, se interpreta como `mail`) |

## 4. Reglas de negocio

### RN-1 Cliente
- Se identifica por DNI (solo dígitos, 7 a 9).
- DNI nuevo → se crea el cliente. DNI existente → se actualizan nombre, dirección y teléfono con los datos del pedido.

### RN-2 Precio
- `subtotal = cantidad × precio_balde` (redondeo a 2 decimales).
- El pedido guarda el precio del momento; cambios posteriores de precio no lo afectan.

### RN-3 Descuento mensual
- El período es el **mes calendario** (del día 1 al último día) de la fecha local del pedido. No hay rango de fechas configurable; el conteo se reinicia el día 1 de cada mes.
- `baldes_acumulados = baldes previos del cliente con fecha_pedido en el mismo mes + cantidad actual`.
- Si `umbral_baldes > 0` y `baldes_acumulados >= umbral_baldes`, se aplica `descuento_pct` al subtotal **de este pedido** (y de los siguientes de ese mes, ya que el acumulado se mantiene alto).
- No es retroactivo: los pedidos anteriores no se recalculan.
- `umbral_baldes = 0` → nunca hay descuento.

### RN-4 Fecha de entrega
- Siempre un **martes o un viernes** (días de entrega), según la fecha/hora local (`TZ_NEGOCIO`, por defecto `America/Argentina/Buenos_Aires`).
- Pedido en un día de entrega antes de `hora_corte` → ese mismo día.
- Pedido en un día de entrega desde `hora_corte` → siguiente día de entrega (martes → viernes, +3 días; viernes → martes, +4 días).
- Cualquier otro día → próximo día de entrega: lunes → martes; miércoles y jueves → viernes; sábado y domingo → martes.
- La `hora_corte` es una sola y vale para ambos días. Los días de entrega son fijos en el código (`DIAS_ENTREGA` en `src/reglas.js`).
- Los pedidos ya registrados conservan su fecha de entrega.

### RN-5 Estados
- `recibido` (inicial) → `en_proceso` → `entregado` → `cobrado`.
- El panel puede asignar cualquiera de los estados `recibido`, `en_proceso` y `entregado` en cualquier orden (el código no impone el orden). **`cobrado` es final:** un pedido cobrado no puede cambiar de estado (409) ni volver a cobrarse.
- **Cobrado y forma de pago:** al pasar un pedido a `cobrado` el panel pide la forma de pago: *contado* (todo efectivo), *transferencia* (todo transferencia) o *combinación* (se indica cuánto de cada una; al cargar un monto el otro se completa con el resto). `pago_efectivo + pago_transferencia` debe ser igual al `total` del pedido (comparado en centavos); si no, el servidor responde 400 y el estado no cambia. Cancelar el diálogo deja el estado como estaba. Como el cobro es definitivo, el selector de estado queda deshabilitado en los pedidos cobrados.
- **Corregir cobro:** en un pedido cobrado el panel ofrece **Corregir cobro**, que abre el mismo diálogo precargado con el pago actual. Los nuevos montos también deben sumar el total. El estado sigue siendo `cobrado`, `fecha_cobro` no cambia y se registra `cobro_corregido_en` (el panel muestra "corregido" con esa fecha). No hay historial de los montos anteriores. Estos datos son la base para la futura administración de caja; el cliente no los ve.

### RN-6 Notificación
- Al crear un pedido se avisa al propietario según `canal_notificacion`: `mail` (por defecto), `telegram` o `ambos`.
- **Mail:** n.º de pedido, datos del cliente (marca "CLIENTE NUEVO" si corresponde), cantidad, subtotal, descuento, total, fecha de entrega y, si los hay, los comentarios del cliente. Vía Resend, SMTP o, sin ninguno configurado, archivo en `outbox/`.
- **Telegram:** resumen corto (n.º de pedido, cliente y DNI, baldes, total, fecha de entrega y comentarios si los hay), enviado por un bot (API oficial de Telegram, `sendMessage`) al `telegram_chat_id`. El token del bot está en la variable de entorno `TELEGRAM_BOT_TOKEN`, no en la base ni en el panel.
- Los canales son independientes: si uno falla (o falta su dato), se registra el error en el log y el pedido y el otro aviso igual salen.
- Validaciones al guardar la configuración: el canal elegido debe tener sus datos (mail → email; telegram → ID de chat numérico y `TELEGRAM_BOT_TOKEN` configurado en el servidor). Cambiar de celular no requiere cambios: Telegram depende de la cuenta, no del número.
- Un `PUT /api/admin/config` que omite los campos de notificación conserva los valores actuales.

## 5. API

### Pública
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Página de pedidos |
| GET | `/api/precio` | `{ precio_balde }` |
| POST | `/api/pedidos` | Crea un pedido |
| GET | `/api/mis-pedidos?dni=&desde=&hasta=` | Historial del cliente identificado por DNI |

**GET `/api/mis-pedidos`** — `dni` obligatorio (7–9 dígitos); `desde` y `hasta` opcionales (`YYYY-MM-DD`, inclusivos, sobre `fecha_pedido`; `desde <= hasta`). Respuesta 200: lista ordenada del más reciente al más antiguo con `id, fecha_pedido, cantidad, precio_unitario, subtotal, descuento_pct, descuento_monto, total, fecha_entrega, estado, comentarios`. No devuelve datos personales. DNI sin pedidos → `[]`. Parámetros inválidos → 400 `{ errores }`.

**POST `/api/pedidos`** — body: `nombre`, `dni`, `direccion`, `telefono`, `cantidad`, `comentarios` (opcional).

Validaciones (400 con `{ errores: [...] }`):
- nombre y dirección no vacíos.
- DNI: 7–9 dígitos (se descartan caracteres no numéricos).
- teléfono: `^[\d\s+()-]{6,}$`.
- cantidad: entero, `0 < cantidad <= 50`.
- comentarios: opcional; se recortan los espacios; máximo 300 caracteres.

Respuesta 201: `{ pedido_id, cliente_nuevo, cliente, cantidad, fecha_entrega, precio_unitario, subtotal, baldes_acumulados, descuento_pct, descuento_monto, total }`.
Error interno → 500 y rollback (cliente y pedido se registran en una sola transacción).

### Panel del propietario (HTTP Basic, `ADMIN_USER` / `ADMIN_PASSWORD`)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin` | Panel |
| GET | `/api/admin/config` | Configuración actual |
| PUT | `/api/admin/config` | Actualiza configuración |
| GET | `/api/admin/pedidos` | Lista pedidos (más recientes primero), con filtros opcionales combinables (AND), ver abajo |
| PATCH | `/api/admin/pedidos/:id` | Body `{ estado }`; si `estado` es `cobrado` también `{ pago_efectivo, pago_transferencia }` (números ≥ 0, uno puede omitirse = 0, deben sumar el total); 400 si el estado es inválido o el pago no cuadra; 404 si no existe o está eliminado; 409 si el pedido ya está cobrado |
| PATCH | `/api/admin/pedidos/:id/cobro` | Corrige la forma de pago de un pedido cobrado. Body `{ pago_efectivo, pago_transferencia }` (mismas reglas: ≥ 0, suman el total); 400 si no cuadra; 404 si no existe o está eliminado; 409 si el pedido no está cobrado |
| DELETE | `/api/admin/pedidos/:id` | Borrado lógico: marca el pedido como eliminado (`eliminado_en`); 404 si no existe o ya estaba eliminado. La confirmación se pide en el panel antes de llamar |
| GET | `/api/admin/clientes` | Clientes con totales: pedidos, baldes_totales, baldes_mes (mes calendario actual), facturado |

**Filtros de `GET /api/admin/pedidos`** (todos opcionales):
| Parámetro | Criterio |
|---|---|
| `dni` | contiene (parcial; se ignoran caracteres no numéricos) |
| `nombre` | contiene, sin distinguir mayúsculas ni acentos (se compara normalizado en la aplicación) |
| `comentario` | el comentario del pedido contiene el texto, sin distinguir mayúsculas ni acentos |
| `eliminados` | vacío: solo pedidos activos (por defecto); `solo`: solo eliminados; `todos`: ambos |
| `estado` | `recibido` \| `en_proceso` \| `entregado` \| `cobrado` |
| `descuento` | `con` (descuento_pct > 0) \| `sin` |
| `desde`, `hasta` | rango de `fecha_pedido`, inclusivo |
| `entrega_desde`, `entrega_hasta` | rango de `fecha_entrega`, inclusivo |

Fechas `YYYY-MM-DD`, con `desde <= hasta` en cada rango. Valores inválidos → 400 `{ errores }`. El panel muestra además un resumen de lo filtrado (cantidad de pedidos, baldes y total).

Validaciones de `PUT /config`: precio > 0; umbral entero ≥ 0; descuento 0–100; hora de corte `HH:MM`; email válido si se informa.

## 6. Configuración (entorno)

| Variable | Por defecto |
|---|---|
| `PORT` | 3000 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / admin |
| `OWNER_EMAIL` | — |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` | — |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram para los avisos (se crea con `@BotFather`) | — |
| `TZ_NEGOCIO` | America/Argentina/Buenos_Aires |
| `DB_PATH` | data/acai.db |

## 7. Requisitos no funcionales y limitaciones conocidas

- **Seguridad:** credenciales por defecto `admin/admin` y Basic Auth sin HTTPS propio; deben cambiarse y ponerse detrás de TLS en producción. No hay rate limiting ni protección anti-spam en el endpoint público.
- **Concurrencia:** el alta de pedido usa `BEGIN IMMEDIATE`, evitando condiciones de carrera en el cálculo del acumulado.
- **Historial por DNI:** el cliente se identifica solo con el DNI, sin segundo factor; quien conozca un DNI puede ver los pedidos (montos, fechas, estado) de esa persona. Pendiente de endurecer (p. ej. DNI + teléfono).
- **Datos personales:** se almacenan DNI, dirección y teléfono sin cifrar.
- **Estados:** no hay validación de transiciones ni registro de auditoría.
- **Descuento:** el cambio de umbral/porcentaje no recalcula pedidos existentes.

## 8. Pruebas

`npm test` (runner nativo de Node): `test/reglas.test.js` (reglas puras) y `test/api.test.js` (endpoints).

## 9. Módulo de administración (caja)

> **Estado: BORRADOR, pendiente de aprobación. Nada de esta sección está implementado.** Metodología: Specification Driven Development. Primero se aprueba esta sección, después se planifican las tareas y recién entonces se implementa (test primero, código después). Las secciones 1 a 8 describen el sistema ya implementado.

### 9.1 Objetivo y alcance del MVP

Permitir al propietario ver cuánto vende, gasta y gana el negocio, por día, por semana y por cualquier rango de fechas, considerando las tres unidades de negocio:

1. **Mayorista:** los pedidos ya desarrollados (secciones 1 a 8). Sus ingresos **no se cargan a mano**: salen de los pedidos en estado `cobrado`.
2. **Minorista (al público):** ventas en la playa, en tres **puntos de venta**: Miramar 1, Miramar 2 y Chapadmalal. Los vendedores **no usan el sistema**: le rinden al propietario y **él carga** el cierre de caja de cada día.
3. **Delivery:** módulo futuro, todavía sin definir. **Fuera del MVP** (ver 9.9). El diseño no debe impedir sumarlo después como una unidad más.

Además hay **gastos generales** del negocio (compra de baldes de açaí, envases descartables, etc.), sin punto de venta asociado.

**Actor único:** el propietario, con el acceso al panel que ya existe (HTTP Basic de `/admin`). No hay usuarios nuevos.

### 9.2 Glosario

| Término | Significado |
|---|---|
| Unidad | Parte del negocio: mayorista, minorista (o delivery, a futuro) |
| Punto de venta | Cada lugar de venta minorista (Miramar 1, Miramar 2, Chapadmalal) |
| Cierre de caja | Registro de un punto de venta para un día: fondo inicial, ingresos, gastos y efectivo contado. Lo carga el propietario con lo que le rinde el vendedor |
| Fondo inicial | Efectivo con el que arranca el vendedor el día (para dar vuelto). No es un ingreso ni entra en el resultado |
| Efectivo esperado | `fondo_inicial + ingresos_efectivo − gastos` |
| Diferencia | `efectivo_contado − efectivo_esperado` (negativa = faltante, positiva = sobrante) |
| Gasto general | Gasto del negocio sin punto de venta (mercadería, envases, publicidad, etc.) |
| Compra de stock | Gasto general de categoría tipo `stock` (mercadería y envases) |
| Gasto corriente | Gasto general de cualquier otra categoría |
| Día sin cierre | Fecha en la que un punto de venta no tiene ningún cierre cargado (distinto de un cierre cargado con todo en cero) |

### 9.3 Reglas de negocio

**RN-C1 Ventas mayoristas (automáticas)**
- Los ingresos mayoristas se calculan a partir de los pedidos con `estado = 'cobrado'` y `eliminado_en IS NULL`. No hay carga manual ni tabla duplicada, por lo que **un pedido nunca cuenta dos veces** y no puede haber ventas sin pedido.
- La **fecha** de la venta es la de `fecha_cobro` (el día en que se cobró), no la del pedido ni la de entrega.
- Efectivo = `pago_efectivo`; transferencia = `pago_transferencia` (ya validados contra el total, RN-5).
- Si el pedido se corrige con **Corregir cobro**, el resumen usa los montos corregidos; la fecha no cambia.
- Un pedido cobrado que se elimina (borrado lógico) deja de contarse. Como `cobrado` es final, no hay otra forma de "des-cobrar".
- No existen pagos parciales (el cobro es siempre por el total del pedido).

**RN-C2 Cierre de caja diario (minorista)**
- Un cierre por **punto de venta y fecha** (único entre los no eliminados).
- Datos: `fondo_inicial`, `ingresos_efectivo`, `ingresos_transferencia`, `gastos` (total del día), `nota_gastos` (opcional, ej. "hielo, nafta"), `efectivo_contado`, `nota_diferencia`.
- `efectivo_esperado = fondo_inicial + ingresos_efectivo − gastos`; `diferencia = efectivo_contado − efectivo_esperado`. Ambos se calculan en el servidor y se guardan; no se aceptan del cliente.
- **Los gastos del punto de venta se asumen pagados con el efectivo de la caja** (por eso restan del esperado).
- Las transferencias **no entran** en el efectivo esperado: no pasan por la caja física. Se registran por separado.
- Si `diferencia ≠ 0` el cierre **se guarda igual** (el faltante o sobrante queda registrado) y `nota_diferencia` es **obligatoria**.
- Todos los montos son ≥ 0. La fecha no puede ser futura (hora local del negocio).
- Se puede cargar con **fecha atrasada**; la fecha del cierre es la del día al que corresponde, no la de la carga. Chapadmalal puede cargarse por semana (un cierre por cada día).
- **Sin cierre ≠ cierre en cero:** que no exista cierre significa "sin cargar"; un cierre con todo en cero significa "ese día no se vendió / no salió". El resumen distingue ambos (RN-C6).
- El **resultado del punto de venta** en un día es `ingresos_efectivo + ingresos_transferencia − gastos`. El fondo inicial y la diferencia de caja **no** entran en el resultado.

**RN-C3 Corrección y borrado de cierres**
- El propietario puede **corregir** cualquier cierre (se recalculan efectivo esperado y diferencia). Se guarda `corregido_en`; no se conserva historial de valores anteriores (ver preguntas abiertas).
- El borrado es **lógico**: `eliminado_en` y `motivo_eliminacion` (obligatorio). Un cierre eliminado no cuenta en ningún resumen y libera la fecha para cargar uno nuevo. Puede listarse con un filtro.
- No hay bloqueo de días ni de meses: lo cargado siempre puede corregirse.

**RN-C4 Gastos generales**
- Campos: `fecha`, `monto` (> 0), `categoria`, `nota` (opcional). Sin periodicidad ni vencimiento: cada gasto se carga a mano con su fecha de compra.
- Categorías iniciales (fijas en el MVP): **mercadería** (stock), **envases y descartables** (stock), **publicidad**, **transporte**, **servicios y alquileres**, **sueldos**, **otros** (todas estas últimas, corrientes).
- **Imputación por caja (decidida):** cada gasto cuenta íntegro en el día, la semana y el mes de su `fecha`. No se prorratea entre meses ni se reparte entre unidades.
- Corrección y borrado igual que RN-C3 (borrado lógico con motivo obligatorio). La fecha no puede ser futura.

**RN-C5 Resultado**
- `resultado = ventas mayoristas + ingresos minoristas − gastos de puntos de venta − gastos generales`.
- Se calcula para cualquier rango `desde`–`hasta` (inclusive) y puede agruparse por día, semana (lunes a domingo) o mes calendario, o devolverse como un único total del rango.
- Los gastos generales se muestran separados en **compras de stock** y **gastos corrientes**. Aviso al propietario en la pantalla: con el criterio por caja, un mes con una compra grande de stock puede verse flojo aunque las ventas hayan sido buenas; el **total del rango completo de la temporada** es la cifra más confiable.

**RN-C6 Datos incompletos**
- Para cada punto de venta activo, el resumen informa cuántos **días del rango no tienen cierre** y cuáles son. Es **informativo**: los puntos de venta no operan todos los días, así que un día sin cierre no es un error ni bloquea nada.
- El resumen no distingue días de playa de días sin operación; para dejar constancia de que un día no hubo venta se carga un cierre en cero.

**RN-C7 Puntos de venta**
- Tres puntos fijos creados por el sistema: Miramar 1, Miramar 2, Chapadmalal (con `activo = 1`). Alta, baja o renombrado desde el panel quedan fuera del MVP.
- Delivery no se modela todavía. Los datos de caja se guardan siempre asociados a su unidad (`mayorista` implícita por los pedidos, `minorista` por el punto de venta) para poder sumar otra unidad sin migrar lo existente.

### 9.4 Modelo de datos

**Dinero:** las tablas nuevas guardan montos como **INTEGER en centavos** (sin float). La API recibe y devuelve pesos con hasta 2 decimales y convierte en el servidor. Los montos de `pedidos` (REAL) se convierten con redondeo a centavos al calcular los resúmenes. Todas las fechas/horas, en la zona horaria del negocio (`TZ_NEGOCIO`).

#### `puntos_venta`
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| nombre | TEXT | único: `Miramar 1`, `Miramar 2`, `Chapadmalal` |
| activo | INTEGER | 1 por defecto |

#### `cierres_caja`
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| punto_venta_id | INTEGER FK | → puntos_venta.id, NOT NULL |
| fecha | TEXT | `YYYY-MM-DD`, día al que corresponde el cierre |
| fondo_inicial | INTEGER | centavos, ≥ 0 |
| ingresos_efectivo | INTEGER | centavos, ≥ 0 |
| ingresos_transferencia | INTEGER | centavos, ≥ 0 |
| gastos | INTEGER | centavos, ≥ 0 |
| nota_gastos | TEXT | opcional, `''` si no hay |
| efectivo_esperado | INTEGER | calculado: `fondo_inicial + ingresos_efectivo − gastos` (puede ser negativo si los gastos superan al efectivo) |
| efectivo_contado | INTEGER | centavos, ≥ 0 |
| diferencia | INTEGER | calculado: `efectivo_contado − efectivo_esperado` |
| nota_diferencia | TEXT | obligatoria si `diferencia ≠ 0` |
| creado_en, actualizado_en | TEXT | `YYYY-MM-DD HH:MM` |
| corregido_en | TEXT | `NULL` si nunca se corrigió |
| eliminado_en | TEXT | `NULL` si está activo (borrado lógico) |
| motivo_eliminacion | TEXT | obligatorio al eliminar |

Restricción: índice único parcial sobre `(punto_venta_id, fecha) WHERE eliminado_en IS NULL`.

#### `categorias_gasto`
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| nombre | TEXT | único |
| tipo | TEXT | CHECK `corriente` \| `stock` |

Carga inicial: ver RN-C4.

#### `gastos_generales`
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| fecha | TEXT | `YYYY-MM-DD` de la compra |
| monto | INTEGER | centavos, > 0 |
| categoria_id | INTEGER FK | → categorias_gasto.id, NOT NULL |
| nota | TEXT | opcional, `''` si no hay |
| creado_en, actualizado_en | TEXT | `YYYY-MM-DD HH:MM` |
| corregido_en | TEXT | `NULL` si nunca se corrigió |
| eliminado_en | TEXT | `NULL` si está activo |
| motivo_eliminacion | TEXT | obligatorio al eliminar |

**Migración:** las tablas son nuevas (`CREATE TABLE IF NOT EXISTS` al arrancar, más la carga inicial de puntos de venta y categorías con `INSERT OR IGNORE`). **No se modifica ninguna tabla existente**, así que los datos actuales de `pedidos` y `clientes` no se tocan.

### 9.5 API (panel del propietario, mismo HTTP Basic que `/api/admin`)

Montos en pesos (número, hasta 2 decimales); fechas `YYYY-MM-DD`. Errores de validación: 400 `{ errores: [...] }`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/admin/puntos-venta` | Lista de puntos de venta |
| GET | `/api/admin/caja/categorias` | Categorías de gasto con su tipo |
| GET | `/api/admin/caja/cierres` | Lista de cierres. Filtros: `desde`, `hasta`, `punto_venta_id`, `eliminados` (vacío: solo activos; `solo`; `todos`). Orden: fecha descendente |
| POST | `/api/admin/caja/cierres` | Crea un cierre. Body: `punto_venta_id`, `fecha`, `fondo_inicial`, `ingresos_efectivo`, `ingresos_transferencia`, `gastos`, `nota_gastos?`, `efectivo_contado`, `nota_diferencia?`. 201 con el cierre y sus campos calculados. 400 si falta algo, hay montos negativos, fecha futura o inválida, o `diferencia ≠ 0` sin nota. 404 si el punto de venta no existe o está inactivo. 409 si ya hay un cierre activo de ese punto y fecha |
| PUT | `/api/admin/caja/cierres/:id` | Corrige un cierre (mismos campos que el alta; el punto de venta y la fecha pueden cambiarse, con la misma regla de unicidad). 404 si no existe o está eliminado; 409 si el nuevo punto/fecha ya tiene un cierre |
| DELETE | `/api/admin/caja/cierres/:id` | Borrado lógico. Body `{ motivo }` obligatorio. 404 si no existe o ya está eliminado |
| GET | `/api/admin/caja/gastos` | Lista de gastos generales. Filtros: `desde`, `hasta`, `categoria_id`, `eliminados` |
| POST | `/api/admin/caja/gastos` | Crea un gasto. Body: `fecha`, `monto`, `categoria_id`, `nota?`. 201. 400 si monto ≤ 0, fecha futura/inválida o categoría inexistente |
| PUT | `/api/admin/caja/gastos/:id` | Corrige un gasto. 404 si no existe o está eliminado |
| DELETE | `/api/admin/caja/gastos/:id` | Borrado lógico con `{ motivo }` obligatorio. 404 si no existe o ya está eliminado |
| GET | `/api/admin/caja/resumen` | Resumen para un rango (ver abajo) |

**GET `/api/admin/caja/resumen`** — parámetros: `desde` y `hasta` (obligatorios, inclusivos, `desde <= hasta`, máximo 366 días) y `agrupar` = `total` (por defecto) \| `dia` \| `semana` \| `mes`. Respuesta 200:

```
{
  desde, hasta, agrupar,
  periodos: [{
    periodo,          // 'total' | '2026-11-12' | '2026-W46' | '2026-11'
    desde, hasta,     // límites efectivos del período dentro del rango pedido
    mayorista:   { efectivo, transferencia, total, pedidos },
    minorista:   { ingresos_efectivo, ingresos_transferencia, ingresos_total, gastos, resultado,
                   puntos: [{ punto_venta_id, nombre, ingresos_efectivo, ingresos_transferencia,
                              ingresos_total, gastos, resultado, dias_con_cierre, diferencia_caja }] },
    gastos_generales: { corrientes, stock, total, por_categoria: [{ categoria, tipo, monto }] },
    resultado
  }],
  avisos: [{ punto_venta_id, nombre, dias_sin_cierre, fechas }]   // RN-C6, informativo
}
```

`diferencia_caja` es la suma de las diferencias de los cierres del período (informativa; no entra en el resultado). Fechas inválidas, `desde > hasta`, rango > 366 días o `agrupar` inválido → 400.

### 9.6 Interfaz (panel `/admin`)

Una pestaña nueva **Caja** con tres vistas: **Cierre diario** (formulario con efectivo esperado y diferencia calculados en vivo, y listado con filtros), **Gastos generales** (formulario y listado) y **Resumen** (rango de fechas, agrupación, desglose por unidad y aviso de días sin cierre). Las eliminaciones piden confirmación y motivo. El detalle de diseño visual no es parte de este spec.

### 9.7 Criterios de aceptación

**Ventas mayoristas (RN-C1)**
- **Dado** un pedido que se pasa a `cobrado` hoy con $3.000 en efectivo y $2.000 por transferencia, **cuando** se pide el resumen de hoy, **entonces** `mayorista` suma efectivo 3000, transferencia 2000, total 5000 y 1 pedido.
- **Dado** un pedido hecho el lunes y cobrado el viernes, **cuando** se pide el resumen del lunes, **entonces** no aparece; en el del viernes sí.
- **Dado** un pedido cobrado cuyo cobro se corrige, **cuando** se pide el resumen, **entonces** usa los montos corregidos y la fecha de cobro original.
- **Dado** un pedido cobrado que se elimina, **cuando** se pide el resumen, **entonces** ya no suma.
- **Dado** un pedido no cobrado (recibido, en proceso o entregado), **entonces** no suma en ningún resumen.

**Cierre de caja (RN-C2, RN-C3)**
- **Dado** fondo 5.000, ingresos en efectivo 20.000, gastos 3.000 y efectivo contado 22.000, **cuando** se crea el cierre, **entonces** `efectivo_esperado = 22000` y `diferencia = 0`, y se guarda sin pedir nota.
- **Dado** el mismo caso con efectivo contado 21.500, **cuando** se crea sin `nota_diferencia`, **entonces** responde 400; con nota, se guarda con `diferencia = -500`.
- **Dado** un cierre existente de Miramar 1 el 10/11, **cuando** se crea otro igual, **entonces** responde 409; si el primero está eliminado, el nuevo se acepta.
- **Dado** un monto negativo o una fecha futura, **entonces** responde 400 y no se guarda nada.
- **Dado** un cierre, **cuando** se corrige un monto, **entonces** se recalculan esperado y diferencia, se completa `corregido_en` y el resumen usa los valores nuevos.
- **Dado** un cierre, **cuando** se elimina sin motivo, **entonces** responde 400; con motivo, deja de contarse en los resúmenes y aparece solo con el filtro `eliminados`.
- **Dado** que las transferencias de un cierre son $8.000, **entonces** no modifican el efectivo esperado ni la diferencia, pero sí los ingresos del resultado.
- **Dado** un cierre con todo en cero, **entonces** se acepta y cuenta como día con cierre.

**Gastos generales (RN-C4)**
- **Dado** un gasto de $50.000 de mercadería fechado el 28/11, **cuando** se pide el resumen de noviembre, **entonces** cuenta íntegro en noviembre, dentro de `stock`; en el de diciembre no aparece.
- **Dado** un gasto de publicidad, **entonces** cuenta dentro de `corrientes`.
- **Dado** un monto 0 o negativo, una categoría inexistente o una fecha futura, **entonces** responde 400.
- **Dado** un gasto eliminado con motivo, **entonces** no cuenta en el resumen.

**Resultado y resumen (RN-C5, RN-C6)**
- **Dado** mayorista 5.000, minorista con ingresos 12.000 y gastos 2.000, y gastos generales 4.000, **entonces** `resultado = 5000 + 12000 − 2000 − 4000 = 11000`.
- **Dado** `agrupar=dia` sobre una semana, **entonces** hay un período por cada día con actividad y la suma de los resultados diarios es igual al resultado de `agrupar=total`.
- **Dado** `agrupar=semana`, **entonces** las semanas van de lunes a domingo; una semana parcial usa solo los días dentro del rango.
- **Dado** que Chapadmalal no tiene cierre 3 días del rango, **entonces** `avisos` lista esos 3 días y el resultado se calcula igual.
- **Dado** un rango inválido (`desde > hasta`, mayor a 366 días, fechas mal formadas), **entonces** responde 400.

**Seguridad y datos existentes**
- **Dado** una llamada a cualquier ruta `/api/admin/caja/*` o `/api/admin/puntos-venta` sin credenciales, **entonces** responde 401.
- **Dada** una base creada antes de este módulo, **cuando** arranca la aplicación, **entonces** las tablas nuevas se crean, los puntos de venta y categorías quedan cargados y los pedidos y clientes existentes no cambian.

### 9.8 Pruebas

Se agregan a `npm test` (`test/caja.test.js` para las reglas puras de cálculo y `test/api.test.js` o un archivo nuevo para los endpoints), siguiendo los criterios de 9.7. Los cálculos (esperado, diferencia, resultado, agrupación por semana) viven en funciones puras testeables, como `src/reglas.js`.

### 9.9 Fuera de alcance (MVP)

- Módulo de **delivery**.
- **Prorrateo** de compras grandes entre meses y reparto de gastos generales entre unidades.
- **Cierre y bloqueo** de días o meses (todo es siempre corregible).
- **Historial de correcciones** (se guarda solo cuándo se corrigió, no los valores anteriores).
- Alta, baja y edición de **puntos de venta** y de **categorías** desde el panel.
- **Stock e inventario**, detalle de qué se vendió (productos, cantidades).
- Medios de pago distintos de efectivo y transferencia (tarjeta, QR) en el minorista.
- Acceso de **vendedores**, carga offline, notificaciones.
- Conciliación de las transferencias con el banco.
- Carga por **totales semanales** sin detalle diario.
- Modificar el borrado de pedidos existente (hoy sin motivo obligatorio ni registro de quién lo hizo).

### 9.10 Supuestos y preguntas abiertas

**Supuestos tomados (a confirmar):**
1. El propietario carga **día por día**, también para Chapadmalal (confirmar con el propietario).
2. Los gastos de cada punto de venta se cargan como **un total del día con una nota**, no ítem por ítem.
3. Los gastos de los puntos de venta **se pagan con el efectivo de la caja**.
4. `efectivo_contado` es **todo el efectivo que hay en la caja al cerrar, incluido el fondo inicial**.
5. Una diferencia de caja distinta de cero **no bloquea** el cierre; queda registrada con nota obligatoria.
6. Las semanas van de **lunes a domingo**.
7. No hay fechas futuras.

**Preguntas abiertas:**
1. ¿Hace falta registrar quién o cuándo corrigió y los valores anteriores, o alcanza con `corregido_en`?
2. ¿Los pedidos mayoristas pueden cobrarse un día y eliminarse días después? Hoy, eliminar un pedido cobrado lo saca retroactivamente de los resúmenes de ese día, porque no hay días cerrados. ¿Es aceptable?
3. ¿Hay que identificar los días de playa para que el aviso de "días sin cierre" solo cuente los que correspondan (por ejemplo, con una temporada de inicio y fin)?
4. ¿Los gastos del minorista alguna vez se pagan con transferencia (y entonces no restan del efectivo esperado)?
5. ¿El delivery tendrá ventas y gastos propios? Cuando se defina, se agrega como una unidad más.

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

> **Estado: BORRADOR v3, pendiente de aprobación. Nada de esta sección está implementado.** Ajustado con las respuestas del propietario (precio del bowl por medio de pago y **según la fecha del cierre**, cierre obligatorio todos los días, **cierre de temporada**, ventas totales y utilidad relativa). Metodología: Specification Driven Development. Primero se aprueba esta sección, después se planifican las tareas y recién entonces se implementa (test primero, código después). Las secciones 1 a 8 describen el sistema ya implementado.

### 9.1 Objetivo y alcance del MVP

Permitir al propietario ver cuánto vende, gasta y gana el negocio, por día, por semana y por cualquier rango de fechas, considerando las tres unidades de negocio:

1. **Mayorista:** los pedidos ya desarrollados (secciones 1 a 8). Sus ingresos **no se cargan a mano**: salen de los pedidos en estado `cobrado`.
2. **Minorista (al público):** ventas en la playa, en tres **puntos de venta**: Miramar 1, Miramar 2 y Chapadmalal. Los vendedores **no usan el sistema**: le rinden al propietario y **él carga** el cierre de caja de cada día. El bowl de açaí tiene **dos precios** (pago en efectivo y pago por transferencia); el vendedor informa **cuántos bowls vendió de cada tipo** y el sistema calcula los ingresos.
3. **Delivery:** módulo futuro, todavía sin definir. **Fuera del MVP** (ver 9.9). El diseño no debe impedir sumarlo después como una unidad más.

Además hay **gastos generales** del negocio (compra de baldes de açaí, envases descartables, etc.), sin punto de venta asociado.

**Actor único:** el propietario, con el acceso al panel que ya existe (HTTP Basic de `/admin`). No hay usuarios nuevos.

### 9.2 Glosario

| Término | Significado |
|---|---|
| Unidad | Parte del negocio: mayorista, minorista (o delivery, a futuro) |
| Punto de venta | Cada lugar de venta minorista (Miramar 1, Miramar 2, Chapadmalal) |
| Precio del bowl | Hay dos, configurados por el propietario: **precio en efectivo** y **precio por transferencia**. Cada par de precios rige **desde una fecha**; un cierre usa los que regían el día al que corresponde |
| Cierre de caja | Registro de un punto de venta para un día, de uno de tres tipos: **trabajado** (fondo inicial, bowls vendidos, gastos y efectivo contado), **no trabajado** (con su motivo) o **fin de temporada**. Lo carga el propietario con lo que le rinde el vendedor |
| Fin de temporada | Cierre especial que indica que el punto de venta deja de operar. Desde el día siguiente **no se esperan más cierres** de ese punto, hasta que se cargue uno nuevo (temporada siguiente) |
| Fondo inicial | Efectivo con el que arranca el vendedor el día (para dar vuelto). No es un ingreso ni entra en el resultado |
| Ventas del día | `bowls_efectivo × precio_efectivo + bowls_transferencia × precio_transferencia` |
| Efectivo esperado | `fondo_inicial + ventas en efectivo − gastos` |
| Diferencia | `efectivo_contado − efectivo_esperado` (negativa = faltante, positiva = sobrante) |
| Utilidad relativa | `ventas − gastos de los puntos de venta`. **No** descuenta los gastos generales (ni el costo de la mercadería, que está en ellos); por eso es "relativa" |
| Resultado | Utilidad relativa menos los gastos generales |
| Gasto general | Gasto del negocio sin punto de venta (mercadería, envases, publicidad, etc.) |
| Compra de stock | Gasto general de categoría tipo `stock` (mercadería y envases) |
| Gasto corriente | Gasto general de cualquier otra categoría |
| Día sin cierre | Día en el que un punto de venta no tiene ningún cierre cargado, ni de día trabajado ni de día no trabajado (RN-C6) |

### 9.3 Reglas de negocio

**RN-C1 Ventas mayoristas (automáticas)**
- Los ingresos mayoristas se calculan a partir de los pedidos con `estado = 'cobrado'` y `eliminado_en IS NULL`. No hay carga manual ni tabla duplicada, por lo que **un pedido nunca cuenta dos veces** y no puede haber ventas sin pedido.
- La **fecha** de la venta es la de `fecha_cobro` (el día en que se cobró), no la del pedido ni la de entrega.
- Efectivo = `pago_efectivo`; transferencia = `pago_transferencia` (ya validados contra el total, RN-5).
- Si el pedido se corrige con **Corregir cobro**, el resumen usa los montos corregidos; la fecha no cambia.
- Un pedido cobrado que se elimina (borrado lógico) deja de contarse. Como `cobrado` es final, no hay otra forma de "des-cobrar".
- No existen pagos parciales (el cobro es siempre por el total del pedido).

**RN-C2 Precios del bowl (configuración, con vigencia por fecha)**
- El propietario define en el **panel de configuración** (el que ya existe) dos precios: en efectivo y por transferencia, ambos > 0, y la fecha **desde** la que rigen (por defecto, hoy). Cada cambio de precios agrega una fila a un **historial de precios** (`precios_bowl`); no se pisa el anterior.
- **Un cierre usa los precios que regían el día al que corresponde** (su `fecha`), no los del día en que se carga. Es decir, el precio vigente en una fecha es el del último cambio con `vigente_desde <= fecha`. Así, un cierre cargado con retraso usa el precio correcto de ese día.
- El precio usado se **guarda en el cierre**: cambiar los precios después **no modifica** cierres ya cargados.
- Al **corregir** un cierre se conservan sus precios, salvo que se cambie su fecha: en ese caso se vuelven a tomar los vigentes en la nueva fecha.
- Para poder cargar un cierre de día trabajado tiene que existir un precio vigente en esa fecha. Si no existe (por ejemplo, todavía no se configuraron, o la fecha es anterior al primer precio), responde 409: "No hay un precio del bowl configurado para esa fecha. Configurá los precios (con la fecha desde la que rigen) antes de cargar el cierre." Para cargar días anteriores al primer precio, basta con configurarlo con una fecha de vigencia anterior.

**RN-C3 Cierre de caja diario (minorista)**
- Un cierre por **punto de venta y fecha** (único entre los no eliminados). Hay tres tipos, según el campo `tipo`:
  - **`trabajado`**: datos `fondo_inicial`, `bowls_efectivo`, `bowls_transferencia` (enteros ≥ 0), `gastos` (total del día), `nota_gastos` (opcional, ej. "hielo, nafta"), `efectivo_contado`, `nota_diferencia`. Un día trabajado **sin ventas se informa con ceros** y es un cierre válido.
  - **`no_trabajado`**: solo `motivo`, **obligatorio** (ej. "lluvia", "mal tiempo", "feriado"). Todos los montos quedan en cero y no hay diferencia de caja.
  - **`fin_temporada`**: indica que el punto de venta termina de operar. `motivo` opcional (si falta, se guarda "Fin de temporada"). Montos en cero. Cuenta como día no trabajado y además activa la regla de RN-C7.
- **Todos los días hay que cargar un cierre por cada punto de venta**, trabaje o no, hasta que se informe el fin de temporada (ver RN-C7).
- Para un día trabajado, el servidor calcula y guarda (no se aceptan del cliente) con los precios vigentes en la fecha del cierre (RN-C2): `ingresos_efectivo = bowls_efectivo × precio_efectivo`, `ingresos_transferencia = bowls_transferencia × precio_transferencia`, `efectivo_esperado = fondo_inicial + ingresos_efectivo − gastos` y `diferencia = efectivo_contado − efectivo_esperado`.
- **Los gastos del punto de venta se pagan siempre en efectivo** (confirmado por el propietario) y por eso restan del esperado.
- Las transferencias **no entran** en el efectivo esperado: no pasan por la caja física. Se registran por separado.
- Si `diferencia ≠ 0` el cierre **se guarda igual** (el faltante o sobrante queda registrado) y `nota_diferencia` es **obligatoria**.
- Todos los montos y cantidades son ≥ 0. La fecha no puede ser futura (hora local del negocio).
- Se puede cargar con **fecha atrasada**; la fecha del cierre es la del día al que corresponde, no la de la carga.
- Para cada cierre de día trabajado se muestran **ventas del día** (`ingresos_efectivo + ingresos_transferencia`) y **utilidad relativa del día** (`ventas − gastos`), además del detalle. El fondo inicial y la diferencia de caja **no** entran en la utilidad.

**RN-C4 Corrección y borrado de cierres**
- El propietario puede **corregir** cualquier cierre (se recalculan ingresos, efectivo esperado y diferencia con los precios guardados en el cierre, o con los de la nueva fecha si esta cambia; se puede cambiar de tipo). Se guarda `corregido_en`. **No se conserva historial de valores anteriores** (decidido por el propietario).
- El borrado es **lógico**: `eliminado_en` y `motivo_eliminacion` (obligatorio). Un cierre eliminado no cuenta en ningún resumen y libera la fecha para cargar uno nuevo. Puede listarse con un filtro.
- No hay bloqueo de días ni de meses: lo cargado siempre puede corregirse.

**RN-C5 Gastos generales**
- Campos: `fecha`, `monto` (> 0), `categoria`, `nota` (opcional). Sin periodicidad ni vencimiento: cada gasto se carga a mano con su fecha de compra.
- Categorías iniciales (fijas en el MVP): **mercadería** (stock), **envases y descartables** (stock), **publicidad**, **transporte**, **servicios y alquileres**, **sueldos**, **otros** (todas estas últimas, corrientes).
- **Imputación por caja (decidida):** cada gasto cuenta íntegro en el día, la semana y el mes de su `fecha`. No se prorratea entre meses ni se reparte entre unidades.
- Corrección y borrado igual que RN-C4 (borrado lógico con motivo obligatorio). La fecha no puede ser futura.

**RN-C6 Resultado, ventas totales y utilidad relativa**
- `ventas totales = ventas mayoristas + ventas minoristas`.
- `utilidad relativa = ventas totales − gastos de los puntos de venta` (sin gastos generales).
- **`resultado del período = utilidad relativa − gastos generales del período`.** Los gastos generales **siempre** se descuentan para calcular el resultado de cualquier período (día, semana, mes o rango), con el criterio por caja de RN-C5: cada gasto cuenta en el período que contiene su fecha. La pantalla muestra la cuenta completa en ese orden: ventas totales → gastos de los puntos de venta → **utilidad relativa** → gastos generales → **resultado**.
- Se calculan para cualquier rango `desde`–`hasta` (inclusive) y pueden agruparse por día, semana (lunes a domingo) o mes calendario, o devolverse como un único total del rango. El resumen muestra también los **bowls vendidos** (efectivo y transferencia) del minorista.
- Los gastos generales se muestran separados en **compras de stock** y **gastos corrientes**. Aviso al propietario en la pantalla: con el criterio por caja, un mes con una compra grande de stock puede verse flojo aunque las ventas hayan sido buenas; el **total del rango completo de la temporada** es la cifra más confiable.

**RN-C7 Días sin cierre y fin de temporada**
- Para cada punto de venta activo, el resumen informa los **días sin cierre**: días entre la fecha de su **primer cierre cargado** y **ayer** (inclusive) que estén dentro del rango pedido y no tengan ningún cierre activo (de ningún tipo). El día de hoy no se cuenta, porque todavía puede estar abierto.
- **Fin de temporada:** los días posteriores a un cierre `fin_temporada` **no se consideran faltantes**, hasta que se cargue otro cierre de ese punto con fecha posterior (comienzo de la siguiente temporada). Los días entre el fin de temporada y ese nuevo cierre tampoco se avisan. Rige **por punto de venta**: Chapadmalal puede terminar en una fecha distinta que Miramar.
- Si se elimina el cierre de fin de temporada, vuelven a avisarse los días faltantes.
- Es **informativo**: no bloquea nada y el resultado se calcula igual con lo cargado.
- El resumen también informa, por punto de venta, **días trabajados** y **días no trabajados** (con sus motivos; el fin de temporada figura con su tipo).

**RN-C8 Puntos de venta**
- Tres puntos fijos creados por el sistema: Miramar 1, Miramar 2, Chapadmalal (con `activo = 1`). Alta, baja o renombrado desde el panel quedan fuera del MVP.
- Delivery no se modela todavía. Los datos de caja se guardan siempre asociados a su unidad (`mayorista` implícita por los pedidos, `minorista` por el punto de venta) para poder sumar otra unidad sin migrar lo existente.

### 9.4 Modelo de datos

**Dinero:** las tablas nuevas guardan montos como **INTEGER en centavos** (sin float). La API recibe y devuelve pesos con hasta 2 decimales y convierte en el servidor. Los montos de `pedidos` (REAL) se convierten con redondeo a centavos al calcular los resúmenes. Todas las fechas/horas, en la zona horaria del negocio (`TZ_NEGOCIO`).

#### `precios_bowl` (historial de precios)
| Campo | Tipo | Notas |
|---|---|---|
| id | INTEGER PK | |
| vigente_desde | TEXT | `YYYY-MM-DD`; único (si se carga otro cambio con la misma fecha, reemplaza al anterior) |
| precio_efectivo | INTEGER | centavos, > 0 |
| precio_transferencia | INTEGER | centavos, > 0 |
| creado_en | TEXT | `YYYY-MM-DD HH:MM` |

El precio vigente en una fecha F es la fila con la mayor `vigente_desde <= F`. La tabla arranca vacía.

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
| tipo | TEXT | CHECK `trabajado` \| `no_trabajado` \| `fin_temporada` |
| motivo | TEXT | obligatorio si `tipo = no_trabajado`; en `fin_temporada` opcional (por defecto "Fin de temporada"); `''` si es trabajado |
| fondo_inicial | INTEGER | centavos, ≥ 0 (0 si no trabajó) |
| bowls_efectivo | INTEGER | cantidad ≥ 0 |
| bowls_transferencia | INTEGER | cantidad ≥ 0 |
| precio_bowl_efectivo | INTEGER | centavos, precio vigente en la `fecha` del cierre (`NULL` si no trabajó) |
| precio_bowl_transferencia | INTEGER | centavos, precio vigente en la `fecha` del cierre (`NULL` si no trabajó) |
| ingresos_efectivo | INTEGER | calculado: `bowls_efectivo × precio_bowl_efectivo` |
| ingresos_transferencia | INTEGER | calculado: `bowls_transferencia × precio_bowl_transferencia` |
| gastos | INTEGER | centavos, ≥ 0, pagados en efectivo |
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

Carga inicial: ver RN-C5.

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

**Migración:** las tablas son nuevas (`CREATE TABLE IF NOT EXISTS` al arrancar, más la carga inicial de puntos de venta y categorías con `INSERT OR IGNORE`). **No se modifica la estructura de ninguna tabla existente**, así que los datos actuales de `pedidos` y `clientes` no se tocan.

### 9.5 API (panel del propietario, mismo HTTP Basic que `/api/admin`)

Montos en pesos (número, hasta 2 decimales); cantidades de bowls, enteros; fechas `YYYY-MM-DD`. Los errores (400, 404 y 409) devuelven `{ errores: [...] }`, igual que el resto del panel. Límites de cordura: montos hasta $1.000.000.000 y hasta 100.000 bowls por medio de pago.

| Método | Ruta | Descripción |
|---|---|---|
| GET / PUT | `/api/admin/config` | **Existente.** El GET agrega `precio_bowl_efectivo`, `precio_bowl_transferencia` (los vigentes hoy, o `null` si no hay) y `precio_bowl_vigente_desde`. En el PUT esos campos son opcionales (para no romper clientes actuales; vacío cuenta como ausente): si vienen **los dos precios** (> 0) se agrega un cambio al historial con `precio_bowl_desde` (por defecto, hoy; puede ser futura); si viene solo uno, 400; si no viene ninguno, el historial no se toca. Si los precios enviados ya son los vigentes en esa fecha, no se agrega nada (así guardar otra configuración no ensucia el historial) |
| GET | `/api/admin/caja/precios` | Historial de precios del bowl, del más reciente al más antiguo |
| GET | `/api/admin/puntos-venta` | Lista de puntos de venta |
| GET | `/api/admin/caja/categorias` | Categorías de gasto con su tipo |
| GET | `/api/admin/caja/cierres` | Lista de cierres, con ventas y utilidad relativa de cada uno. Filtros: `desde`, `hasta`, `punto_venta_id`, `eliminados` (vacío: solo activos; `solo`; `todos`). Orden: fecha descendente |
| POST | `/api/admin/caja/cierres` | Crea un cierre. Body común: `punto_venta_id`, `fecha`, `tipo` (`trabajado` \| `no_trabajado` \| `fin_temporada`). Si `trabajado`: `fondo_inicial`, `bowls_efectivo`, `bowls_transferencia`, `gastos`, `nota_gastos?`, `efectivo_contado`, `nota_diferencia?`. Si `no_trabajado`: `motivo`. Si `fin_temporada`: `motivo?`. 201 con el cierre y sus campos calculados. 400 si falta algo, hay valores negativos o bowls no enteros, fecha futura o inválida, `tipo` inválido, `diferencia ≠ 0` sin nota, o no trabajó sin motivo. 404 si el punto de venta no existe o está inactivo. 409 si ya hay un cierre activo de ese punto y fecha, o si no hay precio del bowl vigente en esa fecha (solo día trabajado) |
| PUT | `/api/admin/caja/cierres/:id` | Corrige un cierre (mismos campos que el alta; el punto de venta y la fecha pueden cambiarse, con la misma regla de unicidad; se conservan los precios guardados salvo que cambie la fecha). 404 si no existe o está eliminado; 409 si el nuevo punto/fecha ya tiene un cierre |
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
    minorista:   { bowls_efectivo, bowls_transferencia,
                   ventas_efectivo, ventas_transferencia, ventas_total,
                   gastos, utilidad_relativa,
                   puntos: [{ punto_venta_id, nombre, bowls_efectivo, bowls_transferencia,
                              ventas_efectivo, ventas_transferencia, ventas_total, gastos,
                              utilidad_relativa, dias_trabajados, dias_no_trabajados,
                              diferencia_caja }] },
    ventas_totales,         // mayorista.total + minorista.ventas_total
    gastos_puntos_venta,    // = minorista.gastos
    utilidad_relativa,      // ventas_totales - gastos_puntos_venta
    gastos_generales: { corrientes, stock, total, por_categoria: [{ categoria, tipo, monto }] },
    resultado               // utilidad_relativa - gastos_generales.total
  }],
  avisos: [{ punto_venta_id, nombre, dias_sin_cierre, fechas }],            // RN-C7, informativo
  no_trabajados: [{ punto_venta_id, nombre, fecha, tipo, motivo }]   // tipo: no_trabajado | fin_temporada
}
```

Con `agrupar=dia`, `semana` o `mes` se devuelve **un período por cada día, semana o mes del rango**, también los que no tuvieron movimientos (en cero); con `total`, un único período. `diferencia_caja` es la suma de las diferencias de los cierres del período (informativa; no entra en el resultado). Fechas inválidas, `desde > hasta`, rango > 366 días o `agrupar` inválido → 400.

### 9.6 Interfaz (panel `/admin`)

- **Configuración (existente):** se agregan los campos "Precio del bowl en efectivo", "Precio del bowl por transferencia" y "Rige desde" (por defecto hoy), con la lista del historial de precios.
- **Pestaña nueva Caja**, con tres vistas:
  - **Cierre diario:** formulario con un selector del tipo de día (trabajó / no trabajó / fin de temporada). Si trabajó: fondo, bowls en efectivo, bowls por transferencia, gastos, efectivo contado; se muestran en vivo las ventas, el efectivo esperado, la diferencia y la utilidad relativa del día. Si no trabajó: solo el motivo. Si es fin de temporada: motivo opcional. Listado con filtros, mostrando ventas y utilidad relativa de cada cierre.
  - **Gastos generales:** formulario y listado.
  - **Resumen:** rango de fechas, agrupación, la cuenta completa **ventas totales → gastos de los puntos de venta → utilidad relativa → gastos generales → resultado del período** con ventas totales, utilidad relativa y resultado bien visibles, desglose por unidad y por punto de venta, bowls vendidos, aviso de días sin cierre y listado de días no trabajados con su motivo.
- Las eliminaciones piden confirmación y motivo. El detalle de diseño visual no es parte de este spec.

### 9.7 Criterios de aceptación

En los ejemplos, precio del bowl: **$4.000 en efectivo** y **$4.500 por transferencia**.

**Precios del bowl (RN-C2)**
- **Dado** que no hay precios configurados, **cuando** se carga un cierre de día trabajado, **entonces** responde 409 con el mensaje de configurar los precios; un cierre de día no trabajado o de fin de temporada se acepta igual.
- **Dado** `PUT /api/admin/config` con precio en efectivo 4000, por transferencia 4500 y desde el 01/11, **entonces** se agregan al historial y `GET` los devuelve; con un precio ≤ 0, o con uno solo de los dos, responde 400.
- **Dado** precios de 4.000/4.500 desde el 01/11 y de 5.000/5.500 desde el 15/11, **cuando** se carga hoy (20/11) el cierre del 12/11, **entonces** usa 4.000 y 4.500 (los de ese día); si se carga el cierre del 16/11, usa 5.000 y 5.500.
- **Dado** un cierre ya cargado, **cuando** el propietario agrega un precio nuevo, **entonces** ese cierre conserva sus precios, ingresos y diferencia.
- **Dado** un cierre del 12/11 y precios modificados después, **cuando** se corrige el cierre sin cambiar la fecha, **entonces** se recalcula con los precios que el cierre ya tenía; si se cambia la fecha al 16/11, toma los vigentes ese día.
- **Dado** que el primer precio rige desde el 15/11, **cuando** se carga un cierre trabajado del 10/11, **entonces** responde 409; configurando el precio con vigencia desde el 01/11 se acepta.

**Ventas mayoristas (RN-C1)**
- **Dado** un pedido que se pasa a `cobrado` hoy con $3.000 en efectivo y $2.000 por transferencia, **cuando** se pide el resumen de hoy, **entonces** `mayorista` suma efectivo 3000, transferencia 2000, total 5000 y 1 pedido.
- **Dado** un pedido hecho el lunes y cobrado el viernes, **cuando** se pide el resumen del lunes, **entonces** no aparece; en el del viernes sí.
- **Dado** un pedido cobrado cuyo cobro se corrige, **cuando** se pide el resumen, **entonces** usa los montos corregidos y la fecha de cobro original.
- **Dado** un pedido cobrado que se elimina, **cuando** se pide el resumen, **entonces** ya no suma.
- **Dado** un pedido no cobrado (recibido, en proceso o entregado), **entonces** no suma en ningún resumen.

**Cierre de caja (RN-C3, RN-C4)**
- **Dado** fondo 5.000, 5 bowls en efectivo, 2 por transferencia, gastos 3.000 y efectivo contado 22.000, **cuando** se crea el cierre, **entonces** `ingresos_efectivo = 20000`, `ingresos_transferencia = 9000`, `efectivo_esperado = 5000 + 20000 − 3000 = 22000`, `diferencia = 0`, ventas del día 29.000 y utilidad relativa del día 26.000; se guarda sin pedir nota.
- **Dado** el mismo caso con efectivo contado 21.500, **cuando** se crea sin `nota_diferencia`, **entonces** responde 400; con nota, se guarda con `diferencia = -500`.
- **Dado** que se informan 2 bowls por transferencia, **entonces** no modifican el efectivo esperado ni la diferencia, pero sí las ventas y la utilidad.
- **Dado** un día trabajado con 0 bowls, gastos 0 y efectivo contado igual al fondo, **entonces** se acepta como cierre con ceros y cuenta como día trabajado.
- **Dado** un cierre `no_trabajado` con motivo "lluvia", **entonces** se acepta, los montos quedan en cero, no hay diferencia y cuenta como día no trabajado; sin motivo responde 400.
- **Dado** un cierre `fin_temporada` sin motivo, **entonces** se acepta con el motivo "Fin de temporada" y cuenta como día no trabajado.
- **Dado** un cierre existente de Miramar 1 el 10/11 (trabajado o no), **cuando** se crea otro igual, **entonces** responde 409; si el primero está eliminado, el nuevo se acepta.
- **Dado** un valor negativo, bowls no enteros o una fecha futura, **entonces** responde 400 y no se guarda nada.
- **Dado** un cierre, **cuando** se corrige un valor, **entonces** se recalculan ingresos, esperado y diferencia, se completa `corregido_en` y el resumen usa los valores nuevos.
- **Dado** un cierre trabajado, **cuando** se corrige a `no_trabajado` con motivo, **entonces** sus montos pasan a cero.
- **Dado** un cierre, **cuando** se elimina sin motivo, **entonces** responde 400; con motivo, deja de contarse en los resúmenes y aparece solo con el filtro `eliminados`.

**Gastos generales (RN-C5)**
- **Dado** un gasto de $50.000 de mercadería fechado el 28/11, **cuando** se pide el resumen de noviembre, **entonces** cuenta íntegro en noviembre, dentro de `stock`; en el de diciembre no aparece.
- **Dado** un gasto de publicidad, **entonces** cuenta dentro de `corrientes`.
- **Dado** un monto 0 o negativo, una categoría inexistente o una fecha futura, **entonces** responde 400.
- **Dado** un gasto eliminado con motivo, **entonces** no cuenta en el resumen.

**Ventas totales, utilidad relativa y resultado (RN-C6)**
- **Dado** mayorista 5.000, minorista con ventas 12.000 y gastos 2.000, y gastos generales 4.000, **entonces** `ventas_totales = 17000`, `utilidad_relativa = 17000 − 2000 = 15000` y `resultado = 15000 − 4000 = 11000`.
- **Dado** un gasto general de $4.000 fechado en una semana sin ventas, **cuando** se pide el resumen de esa semana, **entonces** `utilidad_relativa = 0` y `resultado = −4000` (los gastos generales se descuentan en el período de su fecha).
- **Dado** `agrupar=dia` sobre una semana, **entonces** hay un período por cada día de la semana, **incluidos los días sin movimientos (en cero)**, y la suma de los resultados diarios es igual al resultado de `agrupar=total`; lo mismo vale para ventas totales y utilidad relativa.
- **Dado** `agrupar=semana`, **entonces** las semanas van de lunes a domingo; una semana parcial usa solo los días dentro del rango.
- **Dado** un rango inválido (`desde > hasta`, mayor a 366 días, fechas mal formadas), **entonces** responde 400.

**Días sin cierre (RN-C7)**
- **Dado** que Chapadmalal tiene cierres el 10 y el 14 y ninguno el 11, 12 y 13, y hoy es el 16, **cuando** se pide el resumen del 10 al 16, **entonces** `avisos` lista el 11, 12, 13 y 15 (el 16, que es hoy, no se cuenta) y el resultado se calcula igual.
- **Dado** que el 11 hay un cierre de "no trabajó: lluvia", **entonces** ese día no figura en los avisos y aparece en `no_trabajados` con su motivo.
- **Dado** un punto de venta sin ningún cierre, **entonces** no genera avisos.
- **Dado** que Miramar 2 tiene un cierre `fin_temporada` el 10/03 y hoy es el 20/03, **cuando** se pide el resumen del 01/03 al 20/03, **entonces** no hay avisos por los días del 11 al 19; el 10/03 figura en `no_trabajados` con tipo `fin_temporada`.
- **Dado** el caso anterior, **cuando** en noviembre se carga un cierre nuevo de Miramar 2, **entonces** los días entre marzo y ese cierre no generan avisos, y desde ese cierre vuelven a exigirse los cierres diarios.
- **Dado** que el fin de temporada es de Miramar 2, **entonces** no afecta los avisos de Miramar 1 ni de Chapadmalal.
- **Dado** que se elimina el cierre de fin de temporada, **entonces** vuelven a avisarse los días faltantes posteriores.

**Seguridad y datos existentes**
- **Dado** una llamada a cualquier ruta `/api/admin/caja/*` o `/api/admin/puntos-venta` sin credenciales, **entonces** responde 401.
- **Dada** una base creada antes de este módulo, **cuando** arranca la aplicación, **entonces** las tablas nuevas se crean, los puntos de venta y categorías quedan cargados y los pedidos, clientes y configuración existentes no cambian.
- **Dado** el `PUT /api/admin/config` sin los precios del bowl (como lo usa el panel actual), **entonces** sigue funcionando y no modifica el historial de precios.

### 9.8 Pruebas

Se agregan a `npm test` (`test/caja.test.js` para las reglas puras de cálculo y `test/api.test.js` o un archivo nuevo para los endpoints), siguiendo los criterios de 9.7. Los cálculos (ingresos por bowls, esperado, diferencia, utilidad, resultado, agrupación por semana, días sin cierre) viven en funciones puras testeables, como `src/reglas.js`.

### 9.9 Fuera de alcance (MVP)

- Módulo de **delivery**.
- **Prorrateo** de compras grandes entre meses y reparto de gastos generales entre unidades.
- **Cierre y bloqueo** de días o meses (todo es siempre corregible).
- **Historial de correcciones** (se guarda solo cuándo se corrigió, no los valores anteriores; decidido).
- Alta, baja y edición de **puntos de venta** y de **categorías** desde el panel.
- **Stock e inventario** y otros productos: el minorista vende un solo producto, el bowl.
- Editar o borrar filas del **historial de precios** (solo se agregan cambios nuevos).
- Medios de pago distintos de efectivo y transferencia (tarjeta, QR) en el minorista; gastos de puntos de venta pagados por transferencia.
- Acceso de **vendedores**, carga offline, notificaciones.
- Conciliación de las transferencias con el banco.
- Carga por **totales semanales** sin detalle diario.
- Dar de **baja** un punto de venta (el fin de temporada se informa con un cierre especial).
- Modificar el borrado de pedidos existente (hoy sin motivo obligatorio ni registro de quién lo hizo).

### 9.10 Supuestos y preguntas abiertas

**Decidido con el propietario:**
- El bowl tiene dos precios (efectivo y transferencia), configurables en el panel; el vendedor informa bowls por medio de pago.
- Los gastos de los puntos de venta se pagan en efectivo.
- **Cada cierre usa el precio del bowl vigente el día al que corresponde** (no el del día de carga).
- El cierre es diario y obligatorio; un día no trabajado se informa con su motivo y un día trabajado sin ventas se informa en cero.
- **Al informar el fin de temporada, no se avisan más días sin cierre** de ese punto de venta.
- Los gastos generales se descuentan siempre para calcular el resultado del período.
- Se quiere ver **ventas totales** y **utilidad relativa** (sin gastos generales), en cada cierre y en el resumen.
- No se guardan los valores anteriores al corregir.

**Supuestos tomados (a confirmar):**
1. El propietario carga **día por día**, también para Chapadmalal.
2. Los gastos de cada punto de venta se cargan como **un total del día con una nota**, no ítem por ítem.
3. `efectivo_contado` es **todo el efectivo que hay en la caja al cerrar, incluido el fondo inicial**.
4. Una diferencia de caja distinta de cero **no bloquea** el cierre; queda registrada con nota obligatoria.
5. Las semanas van de **lunes a domingo**.
6. No hay fechas futuras.
7. **Cada cierre guarda el precio que usó**; cambiar el precio después no altera cierres ya cargados, y al corregir se mantienen salvo que cambie la fecha.
8. Los avisos de días sin cierre cuentan **desde el primer cierre cargado** de cada punto de venta hasta **ayer**, salvo los días posteriores a un fin de temporada.
9. Se mantiene el **resultado** (con gastos generales) además de la utilidad relativa que pidió el propietario.

**Preguntas abiertas:**
1. Si un precio se cargó con un error, el historial no se edita (solo se agregan cambios): ¿alcanza con agregar un cambio corregido con la misma fecha (que reemplaza al anterior), sabiendo que los cierres ya cargados conservan el precio viejo? ¿O hace falta **recalcular los cierres existentes**?
2. ¿Los pedidos mayoristas pueden cobrarse un día y eliminarse días después? Hoy, eliminar un pedido cobrado lo saca retroactivamente de los resúmenes de ese día, porque no hay días cerrados. ¿Es aceptable?
3. ¿El **costo de la mercadería** debe verse alguna vez asociado a las ventas (margen real), o alcanza con la utilidad relativa y el resultado por separado?
4. ¿El delivery tendrá ventas y gastos propios? Cuando se defina, se agrega como una unidad más.

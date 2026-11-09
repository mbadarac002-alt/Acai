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
| estado | TEXT | `recibido` \| `en_proceso` \| `entregado` (CHECK) |
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
- `recibido` (inicial) → `en_proceso` → `entregado`.
- El panel puede asignar cualquiera de los tres estados (el código no impone el orden).

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
| PATCH | `/api/admin/pedidos/:id` | Body `{ estado }`; 404 si no existe |
| GET | `/api/admin/clientes` | Clientes con totales: pedidos, baldes_totales, baldes_mes (mes calendario actual), facturado |

**Filtros de `GET /api/admin/pedidos`** (todos opcionales):
| Parámetro | Criterio |
|---|---|
| `dni` | contiene (parcial; se ignoran caracteres no numéricos) |
| `nombre` | contiene, sin distinguir mayúsculas ni acentos (se compara normalizado en la aplicación) |
| `comentario` | el comentario del pedido contiene el texto, sin distinguir mayúsculas ni acentos |
| `estado` | `recibido` \| `en_proceso` \| `entregado` |
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

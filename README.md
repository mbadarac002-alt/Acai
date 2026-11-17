# Açaí · Pedidos mayoristas (prototipo)

Sistema para recibir y administrar pedidos mayoristas de baldes de açaí.

## Cómo correrlo

Requiere Node.js 22.13 o superior.

```bash
npm install
npm start
```

- Página de pedidos para clientes: http://localhost:3000
- Panel del propietario: http://localhost:3000/admin (usuario `admin`, contraseña `admin`)

## Funcionamiento

1. El cliente completa nombre, DNI, dirección, teléfono y cantidad de baldes (mayor a 0 y hasta 50), y opcionalmente comentarios para ese pedido (hasta 300 caracteres, ej. "tocar timbre 2B"). El comentario llega al propietario en el mail y en Telegram, y se ve en el panel y en el historial del cliente.
2. Si es su primer pedido (DNI nuevo), se registra en la base de **clientes**. Si ya existía, se actualizan sus datos de contacto.
3. Se registra el pedido en la base de **pedidos** con estado *Recibido*.
4. Se le muestra al cliente la fecha de entrega y el precio.
5. Se avisa al propietario por mail, Telegram o ambos, según lo que elija en el panel.

### Historial del cliente

En la página de pedidos, la sección **Mis pedidos** permite consultar el historial ingresando solo el DNI, con filtro opcional por rango de fechas del pedido (desde/hasta, inclusivos). Se muestran número, fecha, baldes, descuento, total, fecha de entrega y estado. Nota: al identificarse solo por DNI, cualquiera que conozca un DNI puede ver los pedidos asociados.

### Filtros del panel

En la pestaña **Pedidos** del panel, el propietario puede filtrar (criterios combinables, se aplican al escribir) por DNI, nombre del cliente y texto del comentario (ambos sin distinguir mayúsculas ni acentos), estado, con/sin descuento, rango de fecha del pedido y rango de fecha de entrega. Se muestra un resumen de los resultados: cantidad de pedidos, baldes y total.

### Eliminar pedidos

En la pestaña **Pedidos** del panel, cada pedido tiene un botón **Eliminar** que pide confirmación. El borrado es **lógico**: el pedido queda en la base de datos marcado como eliminado, pero deja de verse para el cliente (en "Mis pedidos") y para el propietario. El propietario puede verlos eligiendo en el filtro **Pedidos eliminados** la opción "Ver solo eliminados" o "Ver activos y eliminados"; ahí aparecen atenuados, con la fecha en que se eliminaron. Un pedido eliminado no cuenta para el descuento mensual ni para los totales de clientes y del resumen, y no puede modificarse. No hay opción para restaurarlo desde el panel.

### Notificaciones al propietario

En el panel (**Configuración → Notificaciones de nuevos pedidos**) el propietario elige recibir los avisos por **mail**, **Telegram** o **ambos**, y carga su email y su ID de chat de Telegram. El valor por defecto es solo mail. Cada canal es independiente: si uno falla, el pedido y el otro aviso igual se registran.

**Configurar Telegram (una sola vez):**
1. Quien administra el sistema crea el bot hablando con `@BotFather` en Telegram (comando `/newbot`) y carga el token que le da en la variable de entorno `TELEGRAM_BOT_TOKEN` (en Railway: Variables).
2. El propietario abre ese bot y toca **Iniciar**; si no, el bot no puede escribirle.
3. El propietario busca `@userinfobot`, toca **Iniciar** y copia el número que figura como *Id*.
4. En el panel se pega ese número en "ID de chat de Telegram", se elige el canal y se guarda.

Si el propietario cambia de celular no hay que hacer nada: Telegram está atado a su cuenta, no a su número. Para recibir los avisos en un grupo, se agrega el bot al grupo y se usa el ID del grupo (negativo).

**Cambiar el mail:** escribir el email nuevo en el panel y guardar. Con el remitente de prueba de Resend (`onboarding@resend.dev`) solo se entrega a la dirección con la que se registró la cuenta de Resend; para otro destinatario hay que registrar la cuenta con ese mail o verificar un dominio propio y actualizar `MAIL_FROM`.

### Reglas

- **Precio:** precio por balde definido en el panel. Cada pedido guarda el precio del momento en que se hizo.
- **Entrega:** los **martes y viernes**. Cada pedido se entrega el día de entrega más cercano. Un pedido hecho un martes o un viernes antes de la hora de corte se entrega ese mismo día; si se hace en o después de la hora de corte, se entrega el siguiente día de entrega (martes → viernes, viernes → martes). Un pedido hecho cualquier otro día va al próximo martes o viernes.
- **Descuento:** el propietario define un umbral de baldes y un porcentaje. Se suman los baldes del cliente en pedidos del mes calendario en curso, incluido el pedido actual. Si el total alcanza el umbral, el descuento se aplica al total de ese pedido y de los siguientes de ese mes. El conteo se reinicia el día 1 de cada mes.
- **Estados:** Recibido → En proceso → Entregado → Cobrado (se cambian desde el panel).
- **Cobro:** al pasar un pedido a *Cobrado*, el panel pide la forma de pago: contado, transferencia o una combinación indicando cuánto fue de cada una (deben sumar el total del pedido). El detalle queda visible bajo el estado y alimenta las ventas mayoristas del resumen de caja. Cobrado es definitivo: un pedido cobrado ya no puede cambiar de estado. Si se cargó mal la forma de pago, el botón **Corregir cobro** permite modificarla (los montos nuevos también deben sumar el total); el panel indica que fue corregido y cuándo.

## Administración de caja

En el panel hay una pestaña **Caja** con tres vistas. Las reglas completas están en la sección 9 de [spec.md](spec.md); lo verificado, en [verificacion-caja.md](verificacion-caja.md).

**Antes de empezar:** en **Configuración → Precio del bowl** se cargan los dos precios del bowl (**efectivo** y **transferencia**) y desde qué fecha rigen. Cada cambio se agrega al historial; los anteriores no se pierden.

### Cierre diario

Hay tres puntos de venta (Miramar 1, Miramar 2 y Chapadmalal). Los vendedores no usan el sistema: le rinden al propietario y **él carga el cierre de cada día**, de uno de tres tipos:

- **Trabajó:** fondo inicial, bowls vendidos en efectivo y por transferencia, gastos del día (siempre pagados en efectivo) y efectivo contado. El sistema calcula en vivo las ventas, el **efectivo esperado** (`fondo + efectivo - gastos`), la **diferencia** con lo contado y la **utilidad del día** (`ventas - gastos`). Si hay diferencia, el cierre se guarda igual pero hay que explicarla.
- **No trabajó:** se informa el motivo (por ejemplo, lluvia). Hay que cargar algo todos los días, aunque no se trabaje.
- **Fin de temporada:** deja de esperarse el cierre diario de ese punto de venta hasta que se cargue un cierre nuevo.

**El precio de cada bowl es el que regía el día del cierre**, aunque se cargue después, y queda guardado en el cierre: cambiar los precios no modifica cierres ya cargados. Un cierre se puede **corregir** o **eliminar** (con motivo); lo eliminado no cuenta y la fecha queda libre.

### Gastos generales

Gastos del negocio sin punto de venta (mercadería, envases y descartables, publicidad, transporte, servicios y alquileres, sueldos, otros). Cada gasto cuenta **entero en el día de su fecha**, sin repartirse entre meses. Se pueden corregir y eliminar (con motivo).

### Resumen

Rango de fechas con atajos (hoy, esta semana, este mes, últimos 30 días), visto como total, día por día, semana por semana (lunes a domingo) o mes por mes, sin ocultar los períodos sin movimientos.

- **Ventas totales** = ventas mayoristas (salen solas de los pedidos *cobrados*, el día del cobro) + ventas de los puntos de venta.
- **Utilidad relativa** = ventas totales − gastos de los puntos de venta (no descuenta los gastos generales).
- **Resultado** = utilidad relativa − gastos generales del período.

Además muestra el desglose por punto de venta (bowls, ventas, gastos, utilidad, días trabajados y diferencia de caja), los **avisos** de días sin cierre (informativos: no bloquean nada) y los días no trabajados con su motivo. Con las compras de stock, un mes con una compra grande puede verse flojo: la cifra más confiable es el total de la temporada.

### Uso desde el celular

El panel se adapta a celular, tablet y PC: en pantallas chicas los listados se muestran como tarjetas y los campos son cómodos para el dedo. Se usa desde el navegador del teléfono.

## Configuración (variables de entorno)

| Variable | Uso | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Acceso al panel | `admin` / `admin` |
| `OWNER_EMAIL` | Email inicial del propietario (después se cambia desde el panel) | — |
| `RESEND_API_KEY` | Envío de mails con [Resend](https://resend.com) (recomendado en Railway) | — |
| `MAIL_FROM` | Remitente de los mails | `Pedidos Acai <onboarding@resend.dev>` |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram para los avisos (se crea con `@BotFather`) | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | Servidor de correo SMTP (alternativa a Resend) | — |
| `TZ_NEGOCIO` | Zona horaria para fechas y hora de corte | `America/Argentina/Buenos_Aires` |
| `DB_PATH` | Archivo SQLite | `data/acai.db`, o `acai.db` dentro del volumen de Railway si hay uno |

Sin Resend ni SMTP configurado, los mails se guardan como archivos de texto en `data/outbox/` para poder revisarlos.

## Publicar en Railway

1. En Railway: **New Project → Deploy from GitHub repo** y elegir este repositorio.
2. En el servicio, **Settings → Networking → Generate Domain** para obtener el link público.
3. Clic derecho en el servicio (o `Ctrl+K`) → **Add Volume**, con *mount path* `/data`. Así la base de datos no se borra en cada despliegue.
4. En **Variables** cargar al menos `ADMIN_PASSWORD`, `OWNER_EMAIL` y, para mails reales, `RESEND_API_KEY`.

Railway bloquea SMTP en sus planes Trial y Hobby, por eso para mails se usa Resend (API por HTTPS).

## Tests

```bash
npm test
```

Incluye las pruebas de los pedidos mayoristas y las del módulo de caja (`test/caja-*.test.js`).

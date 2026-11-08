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

1. El cliente completa nombre, DNI, dirección, teléfono y cantidad de baldes (mayor a 0 y hasta 50), y opcionalmente comentarios para ese pedido (hasta 300 caracteres, ej. "tocar timbre 2B"). El comentario llega al propietario en el mail y el WhatsApp, y se ve en el panel y en el historial del cliente.
2. Si es su primer pedido (DNI nuevo), se registra en la base de **clientes**. Si ya existía, se actualizan sus datos de contacto.
3. Se registra el pedido en la base de **pedidos** con estado *Recibido*.
4. Se le muestra al cliente la fecha de entrega y el precio.
5. Se avisa al propietario por mail, WhatsApp o ambos, según lo que elija en el panel.

### Historial del cliente

En la página de pedidos, la sección **Mis pedidos** permite consultar el historial ingresando solo el DNI, con filtro opcional por rango de fechas del pedido (desde/hasta, inclusivos). Se muestran número, fecha, baldes, descuento, total, fecha de entrega y estado. Nota: al identificarse solo por DNI, cualquiera que conozca un DNI puede ver los pedidos asociados.

### Filtros del panel

En la pestaña **Pedidos** del panel, el propietario puede filtrar (criterios combinables, se aplican al escribir) por DNI, nombre del cliente y texto del comentario (ambos sin distinguir mayúsculas ni acentos), estado, con/sin descuento, rango de fecha del pedido y rango de fecha de entrega. Se muestra un resumen de los resultados: cantidad de pedidos, baldes y total.

### Notificaciones al propietario

En el panel (**Configuración → Notificaciones de nuevos pedidos**) el propietario elige recibir los avisos por **mail**, **WhatsApp** o **ambos**, y carga su email, su teléfono (formato internacional, ej. `+5491112345678`) y la API key de [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/). El valor por defecto es solo mail. Cada canal es independiente: si uno falla, el pedido y el otro aviso igual se registran.

**Activar WhatsApp o cambiar el celular:** desde el WhatsApp del número nuevo, enviar `I allow callmebot to send me messages` al número del bot (figura en callmebot.com). CallMeBot responde con una API key, que se carga en el panel junto al teléfono. La key está atada al número, por eso el panel no deja guardar un teléfono distinto sin una API key nueva.

**Cambiar el mail:** escribir el email nuevo en el panel y guardar. Con el remitente de prueba de Resend (`onboarding@resend.dev`) solo se entrega a la dirección con la que se registró la cuenta de Resend; para otro destinatario hay que registrar la cuenta con ese mail o verificar un dominio propio y actualizar `MAIL_FROM`.

### Reglas

- **Precio:** precio por balde definido en el panel. Cada pedido guarda el precio del momento en que se hizo.
- **Entrega:** los **martes y viernes**. Cada pedido se entrega el día de entrega más cercano. Un pedido hecho un martes o un viernes antes de la hora de corte se entrega ese mismo día; si se hace en o después de la hora de corte, se entrega el siguiente día de entrega (martes → viernes, viernes → martes). Un pedido hecho cualquier otro día va al próximo martes o viernes.
- **Descuento:** el propietario define un umbral de baldes y un porcentaje. Se suman los baldes del cliente en pedidos del mes calendario en curso, incluido el pedido actual. Si el total alcanza el umbral, el descuento se aplica al total de ese pedido y de los siguientes de ese mes. El conteo se reinicia el día 1 de cada mes.
- **Estados:** Recibido → En proceso → Entregado (se cambian desde el panel).

## Configuración (variables de entorno)

| Variable | Uso | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Acceso al panel | `admin` / `admin` |
| `OWNER_EMAIL` | Email inicial del propietario (después se cambia desde el panel) | — |
| `RESEND_API_KEY` | Envío de mails con [Resend](https://resend.com) (recomendado en Railway) | — |
| `MAIL_FROM` | Remitente de los mails | `Pedidos Acai <onboarding@resend.dev>` |
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

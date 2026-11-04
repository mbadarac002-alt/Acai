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

1. El cliente completa nombre, DNI, dirección, teléfono y cantidad de baldes.
2. Si es su primer pedido (DNI nuevo), se registra en la base de **clientes**. Si ya existía, se actualizan sus datos de contacto.
3. Se registra el pedido en la base de **pedidos** con estado *Recibido*.
4. Se le muestra al cliente la fecha de entrega y el precio.
5. Se envía un mail al propietario.

### Reglas

- **Precio:** precio por balde definido en el panel. Cada pedido guarda el precio del momento en que se hizo.
- **Entrega:** el viernes más cercano. Un pedido hecho un viernes antes de la hora de corte se entrega ese mismo día; si se hace después, el viernes siguiente.
- **Descuento:** el propietario define un rango de fechas, un umbral de baldes y un porcentaje. Se suman los baldes del cliente en pedidos dentro del rango, incluido el pedido actual. Si el total alcanza el umbral, el descuento se aplica al total de ese pedido y de los siguientes dentro del rango.
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

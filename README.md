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

1. El cliente completa nombre, DNI, dirección, teléfono y cantidad de baldes (mayor a 0 y hasta 50).
2. Si es su primer pedido (DNI nuevo), se registra en la base de **clientes**. Si ya existía, se actualizan sus datos de contacto.
3. Se registra el pedido en la base de **pedidos** con estado *Recibido*.
4. Se le muestra al cliente la fecha de entrega y el precio.
5. Se envía un mail al propietario.

### Historial del cliente

En la página de pedidos, la sección **Mis pedidos** permite consultar el historial ingresando solo el DNI, con filtro opcional por rango de fechas del pedido (desde/hasta, inclusivos). Se muestran número, fecha, baldes, descuento, total, fecha de entrega y estado. Nota: al identificarse solo por DNI, cualquiera que conozca un DNI puede ver los pedidos asociados.

### Filtros del panel

En la pestaña **Pedidos** del panel, el propietario puede filtrar (criterios combinables, se aplican al escribir) por DNI, nombre del cliente (sin distinguir mayúsculas ni acentos), estado, con/sin descuento, rango de fecha del pedido y rango de fecha de entrega. Se muestra un resumen de los resultados: cantidad de pedidos, baldes y total.

### Reglas

- **Precio:** precio por balde definido en el panel. Cada pedido guarda el precio del momento en que se hizo.
- **Entrega:** el viernes más cercano. Un pedido hecho un viernes antes de la hora de corte se entrega ese mismo día; si se hace después, el viernes siguiente.
- **Descuento:** el propietario define un umbral de baldes y un porcentaje. Se suman los baldes del cliente en pedidos del mes calendario en curso, incluido el pedido actual. Si el total alcanza el umbral, el descuento se aplica al total de ese pedido y de los siguientes de ese mes. El conteo se reinicia el día 1 de cada mes.
- **Estados:** Recibido → En proceso → Entregado (se cambian desde el panel).

## Configuración (variables de entorno)

| Variable | Uso | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Acceso al panel | `admin` / `admin` |
| `OWNER_EMAIL` | Email inicial del propietario (después se cambia desde el panel) | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` | Servidor de correo | — |
| `TZ_NEGOCIO` | Zona horaria para fechas y hora de corte | `America/Argentina/Buenos_Aires` |
| `DB_PATH` | Archivo SQLite | `data/acai.db` |

Sin SMTP configurado, los mails se guardan como archivos de texto en `data/outbox/` para poder revisarlos.

## Tests

```bash
npm test
```

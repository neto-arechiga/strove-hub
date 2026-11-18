# Strove Hub

Todos los sitios de Strove en un solo lugar: números, estado del sitio y solicitudes de cambio.

```
Cada noche:  GA4 + Search Console + GitHub  →  Strove Hub (Cloudflare)  →  tu dashboard
Cada hora:   ¿el sitio responde?
Cambios:     cliente (form) o tú (WhatsApp) → solicitud → issue en GitHub → vista previa → apruebas → en vivo
```

## Qué hay en la fase 1

| Vista | Qué ves |
|---|---|
| **General** | Todos los clientes: visitas, leads, clics desde Google y posición, contra los 28 días anteriores. Semáforo del sitio y solicitudes abiertas. |
| **Ficha del cliente** | Gráfica de 90 días, búsquedas en Google, canales, último deploy, links directos (Analytics, Search Console, Clarity, Bing, GitHub, panel de contenido) y solicitudes. |
| **Formulario del cliente** | Link privado por cliente (`/solicitud/...`). Lo que mandan cae en el Hub y en GitHub como issue. |

| **Redes y contenido** (fase 2) | Seguidores, alcance, views e interacciones de Instagram; gasto y conversaciones de Meta Ads; los últimos posts con sus números; y el **calendario de contenido**. |
| **Aprobación del cliente** | Link privado por cliente (`/aprobar/...`). Ve los posts con imagen y copy, y aprueba o pide cambios desde el celular. |

Siguen después: Clarity y Bing por API (fase 3), resumen con IA, PDF y acceso por cliente (fase 4).

## Cómo se usa el calendario
1. **Planear:** en la ficha del cliente → *Redes y contenido* → clic en un día. Sube la imagen, escribe el copy, elige formato y fecha.
2. **Mandar a aprobación:** el post pasa a *Por aprobar* y el cliente lo ve en su link.
3. **El cliente responde:** *Aprobado* o *Pidió cambios* (con su comentario y su nombre). Lo ves en la tarjeta del cliente.
4. **Programar:** lo programas en Meta Business Suite como siempre y lo marcas *Programado en Meta*.
5. **Publicado:** cuando sale en Instagram, el Hub lo empata solo (mismo día) y le pone sus views.

Meta no permite leer lo programado en Business Suite, por eso el plan vive en el Hub y lo publicado se jala de Instagram.

## Puesta en marcha (una sola vez, ~30 min)

### 1. Repo
1. En GitHub crea el repo privado `strove-hub` (vacío) y sube esta carpeta.
2. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `strove-hub`. Deploy command: `npx wrangler deploy`.

### 2. Base de datos
En tu compu, dentro de la carpeta:
```
npm install
npx wrangler login
npx wrangler d1 create strove-hub      # copia el database_id que te da
```
Pega el `database_id` en `wrangler.jsonc` y luego:
```
npm run db:init
```

### 3. Google (Analytics y Search Console)
1. En **console.cloud.google.com** crea un proyecto `strove-hub` y activa **Google Analytics Data API** y **Google Search Console API**.
2. **IAM → Cuentas de servicio → Crear**: nombre `reportes`. Entra a la cuenta → **Claves → Agregar clave → JSON**. Se descarga un archivo.
3. Cárgalo como secreto: `npx wrangler secret put GOOGLE_SA_KEY` y pega el contenido completo del JSON.
4. Por cada cliente, agrega el correo de la cuenta de servicio (`reportes@….iam.gserviceaccount.com`):
   - **GA4** → Admin → Administración de acceso a la propiedad → **Lector**.
   - **Search Console** → Configuración → Usuarios y permisos → **Restringido**.
5. En `src/clients.js` llena `ga4PropertyId` (Admin → Detalles de la propiedad → el número, no el `G-…`).

### 4. GitHub
Crea un token **fine-grained** (Settings → Developer settings) con acceso a los repos de clientes:
- Issues: lectura y escritura
- Contents, Metadata y Checks: lectura

`npx wrangler secret put GITHUB_TOKEN`

### 4b. Meta (Instagram y pauta)
1. En el **Business Manager de Strove** → Configuración → Usuarios → **Usuarios del sistema** → Agregar: `strove-hub`, rol Empleado.
2. **Asignar activos:** las cuentas de Instagram y las cuentas publicitarias de cada cliente, solo lectura.
3. Crea una app en **developers.facebook.com** (tipo Empresa) y conéctala al Business Manager.
4. En el usuario del sistema → **Generar token**, elige la app y los permisos `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, `pages_show_list`, `ads_read`. Elige que **no caduque**.
5. `npx wrangler secret put META_TOKEN`
6. En `src/clients.js` llena `igUserId` (ID de la cuenta de Instagram profesional), `igUsername` y `adAccountId` (sin `act_`).

### 5. Link del formulario
`npx wrangler secret put FORM_SECRET` y escribe cualquier frase larga. Si algún día la cambias, los links de los clientes dejan de servir y se generan nuevos.

### 6. Acceso para el equipo de Strove
1. Cloudflare **Zero Trust** → Access → Applications → **Add → Self-hosted**, dominio del Hub.
2. Política **Allow** → Emails: los correos del equipo (hoy son 3). Todos ven y editan todo.
   Para sumar o quitar a alguien, solo cambias esta lista. No se toca código. El plan gratis de Zero Trust alcanza para hasta 50 personas.
   Cada quien entra con su correo: le llega un código y listo, sin contraseñas.
3. Segunda política **Bypass** → Everyone, solo para las rutas `/solicitud/*`, `/aprobar/*` y `/logo/*` (lo que ve el cliente).
4. Copia el **Application Audience (AUD) Tag** a `ACCESS_AUD` en `wrangler.jsonc`, tu nombre de equipo a `ACCESS_TEAM` y la URL a `HUB_URL`.

Sin `ACCESS_AUD`, el Hub no deja entrar a nadie. Así no queda abierto por accidente.

### 7. Primera carga
Entra al Hub y presiona **Sincronizar**. La primera vez trae 90 días de historial.

## Logos
Cada marca muestra su logo en lugar del nombre. Vienen de `public/logos/<slug>.png` (versión clara, porque el fondo es oscuro).
Para cambiarlo sin tocar código: en la ficha del cliente → **Cambiar logo** (PNG, JPG, WebP o SVG, máx. 900 KB).

## Sumar un cliente
1. Agrega su bloque en `src/clients.js`, su logo en `public/logos/` y haz commit.
2. Da acceso a la cuenta de servicio en su GA4 y Search Console, y al token de GitHub sobre su repo.
3. **Sincronizar**.

## Flujo de una solicitud
1. **Entra:** el cliente llena su formulario, o tú la capturas en su ficha (lo que te llegó por WhatsApp).
2. **Issue:** se crea en el repo del cliente con la etiqueta `solicitud`.
3. **Cambio:** se hace en una rama. Cloudflare genera una URL de vista previa; pégala en la solicitud y mándasela al cliente.
4. **Publicar:** apruebas, merge a `main`, y en 1–2 min está en vivo. Al cerrar el issue, la solicitud pasa sola a **Publicada**.

Los cambios de texto y fotos los puede hacer el cliente desde el panel de contenido (Pages CMS), sin solicitud.

## Desarrollo local
```
npm install
npm run db:init:local && npm run db:demo:local   # datos de PRUEBA, solo en tu compu
# (para ver la parte de redes en local, pon igUserId: 'demo' en clients.js; no lo subas así)
printf 'DEV_BYPASS=1\nFORM_SECRET=local\n' > .dev.vars
npm run dev                                       # http://localhost:8787
```
`DEV_BYPASS` salta el login. Nunca lo pongas en producción.

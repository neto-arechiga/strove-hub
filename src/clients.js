// Registro de clientes del Hub.
// Para sumar un cliente: copia un bloque, cambia los datos y haz commit.
// Los campos vacíos simplemente no se muestran (el Hub no falla si falta algo).

export const CLIENTS = [
  {
    slug: 'viajes-aot',
    name: 'Viajes AOT',
    url: 'https://viajesaot.com',
    repo: 'neto-arechiga/viajesaot-web',
    branch: 'main',
    ga4PropertyId: '564939121',     // número de la propiedad (Admin → Detalles de la propiedad), no el G-…
    gscSite: 'sc-domain:viajesaot.com',
    leadEvent: 'click_whatsapp',    // qué cuenta como lead
    clarityId: 'zf9o0ztr0m',
    cms: 'pages-cms',
    // Meta (desde el Business Manager de Strove)
    igUsername: 'viajesaot',                 // @ de Instagram sin arroba: con eso el Hub encuentra la cuenta solo
    igUserId: '',                   // opcional: se detecta solo a partir del @
    adAccountName: 'Viajes AOT ads', // cuenta publicitaria por nombre (o adAccountId)
    adAccountId: '',                // act_… sin el "act_"; vacío si no hay pauta
    color: '#534AB7',
    report: { bg: '#1C2A24', accent: '#A9C7B2', warm: '#3B5A4B', muted: '#A9C7B2', cream: '#EFEDE6', card: '#E2E6DF' }, // colores de sus documentos (parrilla y reporte)
  },
  {
    slug: 'lentes-sol-y-mas',
    name: 'Lentes Sol y Más',
    url: 'https://lentessolymas.com',
    repo: 'neto-arechiga/lentes-sol-y-mas',
    branch: 'main',
    ga4PropertyId: '',              // pendiente: el sitio todavía no tiene GA4 instalado
    gscSite: 'sc-domain:lentessolymas.com',
    leadEvent: 'click_whatsapp',
    clarityId: '',                  // pendiente
    cms: '',
    igUserId: '',
    igUsername: 'lentesolymas',
    adAccountId: '',
    color: '#F25C2A',
  },
  {
    slug: 'mm-estudio-interior',
    name: 'MM Estudio Interior',
    url: 'https://mmestudiointerior.com',
    platform: 'framer',             // sitio hecho en Framer: sin repo de GitHub
    repo: '',
    ga4PropertyId: '529187765',     // GA4 de MM (acceso vía hola@strove.mx)
    gscSite: 'sc-domain:mmestudiointerior.com', // conectado (propietario: netoogare@gmail.com)
    leadEvent: '',
    clarityId: 'vyaifik3h2',
    cms: 'framer',
    social: false,                  // no le llevamos redes
    color: '#C9A27E',
  },
];

export const getClient = (slug) => CLIENTS.find((c) => c.slug === slug);

export function clientLinks(c) {
  const links = [];
  if (c.url) links.push({ label: 'Sitio', href: c.url });
  if (c.ga4PropertyId) links.push({ label: 'Analytics', href: `https://analytics.google.com/analytics/web/#/p${c.ga4PropertyId}/reports/intelligenthome` });
  if (c.gscSite) links.push({ label: 'Search Console', href: `https://search.google.com/search-console?resource_id=${encodeURIComponent(c.gscSite)}` });
  if (c.clarityId) links.push({ label: 'Clarity', href: `https://clarity.microsoft.com/projects/view/${c.clarityId}/dashboard` });
  if (c.url) links.push({ label: 'Bing', href: `https://www.bing.com/webmasters/home?siteUrl=${encodeURIComponent(c.url + '/')}` });
  if (c.igUsername) links.push({ label: 'Instagram', href: `https://www.instagram.com/${c.igUsername}/` });
  if (c.social !== false) links.push({ label: 'Business Suite', href: 'https://business.facebook.com/latest/content_calendar' });
  if (c.repo) links.push({ label: 'GitHub', href: `https://github.com/${c.repo}` });
  if (c.cms === 'framer') links.push({ label: 'Editar en Framer', href: 'https://framer.com/projects/' });
  if (c.cms === 'pages-cms') links.push({ label: 'Editar contenido', href: `https://app.pagescms.org/${c.repo}/${c.branch || 'main'}` });
  return links;
}

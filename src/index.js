// Strove Hub · Worker principal
import { CLIENTS, getClient, clientLinks } from './clients.js';
import { accessUser, formToken, checkFormToken } from './auth.js';
import { syncAll, syncClient, uptimeAll, refreshRequests } from './sync.js';
import { createIssue } from './github.js';
import { renderReport } from './report.js';
import { discoverInstagram } from './meta.js';
import { renderPreview } from './preview.js';
import { handleMcp } from './mcp.js';
import dashboardHtml from './ui/dashboard.html';
import formHtml from './ui/form.html';
import approveHtml from './ui/aprobar.html';
import schemaSql from '../schema.sql';

// Crea las tablas que falten (la primera vez, o cuando agregamos algo nuevo). No borra nada.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const stmts = schemaSql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((x) => x.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((q) => env.DB.prepare(q)));
  // Columnas nuevas en tablas existentes (falla sin problema si ya existen)
  for (const q of ['ALTER TABLE content_plan ADD COLUMN series TEXT', 'ALTER TABLE content_plan ADD COLUMN brief TEXT']) { try { await env.DB.prepare(q).run(); } catch { /* ya existe */ } }
  schemaReady = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date().toISOString();
const STATUSES = ['nueva', 'en_proceso', 'en_revision', 'publicada', 'descartada'];

// ---------- consultas ----------
const SUM_METRICS = { sessions: 'ga4', users: 'ga4', leads: 'ga4', clicks: 'gsc', impressions: 'gsc' };

async function lastDates(env, slug) {
  const { results } = await env.DB.prepare('SELECT source, MAX(date) AS d FROM metrics WHERE client = ? GROUP BY source').bind(slug).all();
  return Object.fromEntries(results.map((r) => [r.source, r.d]));
}
const shift = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);

// Últimos 28 días con datos vs. los 28 anteriores, por fuente
async function kpis(env, slug) {
  const last = await lastDates(env, slug);
  const out = {};
  for (const source of ['ga4', 'gsc', 'ig', 'ads']) {
    const end = last[source];
    if (!end) continue;
    const cur = [shift(end, -27), end];
    const prev = [shift(end, -55), shift(end, -28)];
    const { results } = await env.DB.prepare(
      `SELECT metric,
         SUM(CASE WHEN date BETWEEN ?1 AND ?2 THEN value END) AS cur,
         SUM(CASE WHEN date BETWEEN ?3 AND ?4 THEN value END) AS prev,
         AVG(CASE WHEN date BETWEEN ?1 AND ?2 THEN value END) AS cur_avg,
         AVG(CASE WHEN date BETWEEN ?3 AND ?4 THEN value END) AS prev_avg
       FROM metrics WHERE client = ?5 AND source = ?6 GROUP BY metric`)
      .bind(cur[0], cur[1], prev[0], prev[1], slug, source).all();
    for (const r of results) {
      const avg = r.metric === 'position';
      out[r.metric] = { cur: avg ? r.cur_avg : r.cur, prev: avg ? r.prev_avg : r.prev, until: end };
    }
  }
  // Seguidores: no se suman, se compara el último dato contra el de hace 28 días
  const f = await env.DB.prepare("SELECT date, value FROM metrics WHERE client = ? AND metric = 'followers' ORDER BY date DESC LIMIT 1").bind(slug).first();
  if (f) {
    const old = await env.DB.prepare("SELECT value FROM metrics WHERE client = ? AND metric = 'followers' AND date <= ? ORDER BY date DESC LIMIT 1")
      .bind(slug, shift(f.date, -28)).first();
    out.followers = { cur: f.value, prev: old?.value ?? null, until: f.date };
  } else delete out.followers;
  // Views e interacciones de los posts publicados en los últimos 28 días
  const today = new Date().toISOString().slice(0, 10);
  const pv = await env.DB.prepare(
    `SELECT SUM(CASE WHEN local_date > ?1 THEN views END) AS cur, SUM(CASE WHEN local_date BETWEEN ?2 AND ?1 THEN views END) AS prev,
            SUM(CASE WHEN local_date > ?1 THEN COALESCE(likes,0)+COALESCE(comments,0)+COALESCE(saves,0)+COALESCE(shares,0) END) AS icur,
            SUM(CASE WHEN local_date BETWEEN ?2 AND ?1 THEN COALESCE(likes,0)+COALESCE(comments,0)+COALESCE(saves,0)+COALESCE(shares,0) END) AS iprev,
            COUNT(CASE WHEN local_date > ?1 THEN 1 END) AS n
     FROM posts WHERE client = ?3`).bind(shift(today, -28), shift(today, -56), slug).first();
  if (pv && pv.n) {
    out.post_views = { cur: pv.cur, prev: pv.prev };
    out.interactions = { cur: pv.icur, prev: pv.iprev };
    out.posts_count = { cur: pv.n, prev: null };
  }
  return out;
}

async function series(env, slug, metrics, days) {
  const last = await lastDates(env, slug);
  const end = [last.ga4, last.gsc].filter(Boolean).sort().pop();
  if (!end) return { dates: [], values: {} };
  const start = shift(end, -(days - 1));
  const ph = metrics.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT date, metric, value FROM metrics WHERE client = ? AND date >= ? AND metric IN (${ph}) ORDER BY date`)
    .bind(slug, start, ...metrics).all();
  const dates = Array.from({ length: days }, (_, i) => shift(start, i));
  const values = Object.fromEntries(metrics.map((m) => [m, dates.map(() => null)]));
  const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
  for (const r of results) if (idx[r.date] !== undefined) values[r.metric][idx[r.date]] = r.value;
  return { dates, values };
}

const logoUrl = (slug, v) => `/logo/${slug}${v ? '?v=' + encodeURIComponent(v) : ''}`;
const statusOf = (env, slug) => env.DB.prepare('SELECT * FROM site_status WHERE client = ?').bind(slug).first();

// ---------- conector de Claude (MCP) ----------
async function mcpKey(env, regenerate = false) {
  const row = !regenerate && await env.DB.prepare("SELECT value FROM settings WHERE key = 'mcp_key'").first();
  if (row?.value) return row.value;
  const k = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mcp_key', ?)").bind(k).run();
  return k;
}

// ---------- kit de marca ----------
const hexOk = (h) => /^#[0-9a-fA-F]{6}$/.test(h || '');
function mixHex(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
async function brandOf(env, slug) {
  const row = await env.DB.prepare('SELECT data, cover IS NOT NULL AS has_cover, updated_at FROM brands WHERE client = ?').bind(slug).first();
  if (!row) return null;
  try { return { ...JSON.parse(row.data), hasCover: !!row.has_cover, updated_at: row.updated_at }; } catch { return null; }
}
// Cliente con su kit de marca aplicado (colores de documentos, @ de Instagram, portada)
async function withBrand(env, c) {
  const b = await brandOf(env, c.slug);
  if (!b) return { ...c, brand: { dark: c.report?.bg || '#1F2B26', accent: c.report?.accent || c.color || '#BDBAB2', light: c.report?.cream || '#F1EFEA', ig: c.igUsername || '' } };
  const dark = hexOk(b.dark) ? b.dark : '#1F2B26', accent = hexOk(b.accent) ? b.accent : c.color, light = hexOk(b.light) ? b.light : '#F1EFEA';
  return { ...c, igUsername: b.ig || c.igUsername,
    report: { bg: dark, accent, cream: light, card: mixHex(light, dark, 0.07), muted: mixHex(accent, light, 0.35), warm: mixHex(dark, accent, 0.22) },
    coverUrl: b.hasCover ? `/brand-cover/${c.slug}?v=${encodeURIComponent(b.updated_at)}` : null,
    brand: { dark, accent, light, ig: b.ig || c.igUsername || '' } };
}

// ---------- ciclo del mes: parrilla → aprobada → programada → reporte ----------
const ymOf = (iso) => iso.slice(0, 7);
const ymShift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesName = (ym) => MES[+ym.slice(5, 7) - 1];
async function planCounts(env, slug, ym) {
  return env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(status IN ('aprobado','programado','publicado')) AS approved,
      SUM(status IN ('programado','publicado') OR post_id IS NOT NULL) AS scheduled,
      SUM(status = 'por_aprobar') AS pending, SUM(status = 'cambios') AS changes, SUM(status = 'borrador') AS drafts
    FROM content_plan WHERE client = ? AND substr(date, 1, 7) = ?`).bind(slug, ym).first();
}
async function monthCycle(env, slug) {
  const ym = ymOf(mxToday()), prevYm = ymShift(ym, -1), nextYm = ymShift(ym, 1);
  const [cur, next] = await Promise.all([planCounts(env, slug, ym), planCounts(env, slug, nextYm)]);
  const rep = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`reportdone:${slug}:${prevYm}`).first();
  const n = (x) => x || 0;
  return { mes: mesName(ym), prevMes: mesName(prevYm), nextMes: mesName(nextYm), ym, nextYm, prevYm,
    cur: { total: n(cur?.total), approved: n(cur?.approved), scheduled: n(cur?.scheduled), pending: n(cur?.pending), changes: n(cur?.changes) },
    next: { total: n(next?.total), approved: n(next?.approved), pending: n(next?.pending), changes: n(next?.changes) },
    report: { done: !!rep, at: rep?.value || null } };
}

// ---------- lo urgente ----------
const LEVEL = { alta: 0, media: 1, baja: 2 };
const SRC_NAME = { ga4: 'Analytics', gsc: 'Search Console', github: 'GitHub', instagram: 'Instagram', pauta: 'Meta Ads', programados: 'lo programado en Facebook', uptime: 'el sitio', solicitudes: 'solicitudes' };
const mxToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const dLabel = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);
async function urgentItems(env) {
  const today = mxToday(), in3 = shift(today, 3), in6 = shift(today, 6), w2a = shift(today, 7), w2b = shift(today, 13);
  const out = [];
  const add = (c, level, text, tab, action = 'Ver') => out.push({ client: c.slug, name: c.name, color: c.color, logo: logoUrl(c.slug), level, text, action, link: tab.startsWith('#') ? tab : `#/c/${c.slug}/${tab}` });
  const day = +today.slice(8, 10);
  for (const c of CLIENTS) {
    const st = await statusOf(env, c.slug);
    if (st?.checked_at && !(st.http_status >= 200 && st.http_status < 400)) add(c, 'alta', st.http_status ? `El sitio responde con error ${st.http_status}` : 'El sitio no responde', 'sitio', 'Revisar sitio');
    if (st?.deploy_state === 'failure') add(c, 'alta', 'La última publicación del sitio falló', 'sitio', 'Revisar sitio');

    const { results: logs } = await env.DB.prepare('SELECT source, ok, message FROM sync_log WHERE client = ? ORDER BY id DESC LIMIT 20').bind(c.slug).all();
    const seen = new Set();
    for (const l of logs) { if (seen.has(l.source)) continue; seen.add(l.source); if (!l.ok) add(c, 'baja', `No se pudo leer ${SRC_NAME[l.source] || l.source}: ${String(l.message).slice(0, 80)}`, l.source === 'instagram' || l.source === 'pauta' || l.source === 'programados' ? 'redes' : 'sitio', 'Ver'); }

    if (c.social !== false) {
      const q = (a, z) => env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM content_plan WHERE client = ?1 AND date BETWEEN ?2 AND ?3 AND status IN ('por_aprobar','cambios','aprobado','programado'))
              + (SELECT COUNT(*) FROM scheduled_posts WHERE client = ?1 AND local_date BETWEEN ?2 AND ?3) AS n`).bind(c.slug, a, z).first();
      const thisWeek = (await q(today, in6)).n, nextWeek = (await q(w2a, w2b)).n;
      if (thisWeek === 0) add(c, 'alta', 'No hay nada para publicar en los próximos 7 días', 'redes', 'Planear');
      else if (nextWeek === 0) add(c, 'media', 'La semana siguiente está vacía', 'redes', 'Planear');

      const { results: plan } = await env.DB.prepare(
        "SELECT date, title, format, status FROM content_plan WHERE client = ? AND date BETWEEN ? AND ? AND status IN ('por_aprobar','cambios','aprobado','borrador') ORDER BY date")
        .bind(c.slug, today, in6).all();
      const toSchedule = plan.filter((p) => p.status === 'aprobado');
      if (toSchedule.length) add(c, toSchedule.some((p) => p.date <= in3) ? 'alta' : 'media', `${toSchedule.length} post${toSchedule.length > 1 ? 's' : ''} aprobado${toSchedule.length > 1 ? 's' : ''} por programar en Meta (el primero sale ${dLabel(toSchedule[0].date)})`, 'redes', 'Programar');
      for (const p of plan) {
        const what = p.title || p.format;
        if (p.status === 'cambios') add(c, 'alta', `El cliente pidió cambios en "${what}" (sale ${dLabel(p.date)})`, 'redes', 'Ver cambios');
        else if (p.status === 'por_aprobar' && p.date <= in3) add(c, 'alta', `"${what}" sigue sin aprobar y sale ${dLabel(p.date)}`, 'redes', 'Recordar al cliente');
        else if (p.status === 'borrador' && p.date <= in3) add(c, 'media', `"${what}" sigue en borrador y sale ${dLabel(p.date)}`, 'redes', 'Terminar');
      }
      // Ciclo del mes: parrilla del siguiente mes y reporte del mes pasado
      const cy = await monthCycle(env, c.slug);
      if (day >= 18 && cy.next.total === 0) add(c, day >= 25 ? 'alta' : 'media', `${cap1(cy.nextMes)} todavía no tiene parrilla`, 'redes', 'Subir parrilla');
      else if (cy.next.pending) add(c, 'media', `Parrilla de ${cy.nextMes}: ${cy.next.pending} post${cy.next.pending > 1 ? 's' : ''} esperando aprobación del cliente`, 'redes', 'Ver');
      if (cy.next.changes) add(c, 'alta', `Parrilla de ${cy.nextMes}: el cliente pidió cambios en ${cy.next.changes} post${cy.next.changes > 1 ? 's' : ''}`, 'redes', 'Ver cambios');
      if (day <= 12 && !cy.report.done) add(c, day >= 6 ? 'alta' : 'media', `Falta el reporte de ${cy.prevMes}`, `#/c/${c.slug}/redes?reporte=${cy.prevYm}`, 'Hacer reporte');
    }

    const { results: reqs } = await env.DB.prepare("SELECT title, created_at FROM requests WHERE client = ? AND status = 'nueva' ORDER BY id").bind(c.slug).all();
    for (const r of reqs) {
      const hrs = (Date.now() - Date.parse(r.created_at)) / 3600_000;
      add(c, hrs > 48 ? 'alta' : 'media', `Cambio al sitio sin atender${hrs > 24 ? ` (${Math.floor(hrs / 24)} d)` : ''}: "${String(r.title).slice(0, 70)}"`, 'cambios', 'Atender');
    }
  }
  return out.sort((a, z) => LEVEL[a.level] - LEVEL[z.level]);
}

async function overview(env) {
  const { results: open } = await env.DB.prepare(
    "SELECT client, COUNT(*) AS n FROM requests WHERE status NOT IN ('publicada','descartada') GROUP BY client").all();
  const openBy = Object.fromEntries(open.map((r) => [r.client, r.n]));
  const lastSync = await env.DB.prepare('SELECT MAX(run_at) AS t FROM sync_log').first();
  const { results: pend } = await env.DB.prepare(
    "SELECT client, SUM(status = 'por_aprobar') AS aprobar, SUM(status = 'cambios') AS cambios, SUM(status IN ('aprobado','programado') AND date >= date('now')) AS proximos FROM content_plan GROUP BY client").all();
  const planBy = Object.fromEntries(pend.map((r) => [r.client, r]));
  const { results: lg } = await env.DB.prepare('SELECT client, updated_at FROM logos').all();
  const logoV = Object.fromEntries(lg.map((r) => [r.client, r.updated_at]));
  const clients = [];
  for (const c of CLIENTS) {
    clients.push({
      slug: c.slug, name: c.name, url: c.url, color: c.color, logo: logoUrl(c.slug, logoV[c.slug]),
      kpis: await kpis(env, c.slug),
      spark: await series(env, c.slug, ['sessions', 'clicks'], 28),
      status: await statusOf(env, c.slug),
      openRequests: openBy[c.slug] || 0,
      setup: { ga4: !!c.ga4PropertyId, gsc: !!c.gscSite, clarity: !!c.clarityId, cms: !!c.cms, ig: !!(c.igUserId || c.igUsername || c.fbPageId), social: c.social !== false, repo: !!c.repo },
      plan: { aprobar: planBy[c.slug]?.aprobar || 0, cambios: planBy[c.slug]?.cambios || 0, proximos: planBy[c.slug]?.proximos || 0 },
      cycle: c.social !== false ? await monthCycle(env, c.slug) : null,
      brand: (await withBrand(env, c)).brand,
    });
  }
  return { clients, lastSync: lastSync?.t || null, urgent: await urgentItems(env) };
}

async function clientDetail(env, c) {
  const { results: br } = await env.DB.prepare('SELECT kind, label, value, extra FROM breakdowns WHERE client = ? ORDER BY kind, rank').bind(c.slug).all();
  const { results: reqs } = await env.DB.prepare('SELECT * FROM requests WHERE client = ? ORDER BY id DESC LIMIT 100').bind(c.slug).all();
  const { results: logs } = await env.DB.prepare('SELECT run_at, source, ok, message FROM sync_log WHERE client = ? ORDER BY id DESC LIMIT 12').bind(c.slug).all();
  let formUrl = null, approveUrl = null;
  try {
    formUrl = `${env.CLIENT_URL || env.HUB_URL || ''}/solicitud/${c.slug}?k=${await formToken(env, c.slug)}`;
    approveUrl = `${env.CLIENT_URL || env.HUB_URL || ''}/aprobar/${c.slug}?k=${await formToken(env, c.slug, 'plan')}`;
  } catch { /* sin base de datos lista */ }
  const { results: posts } = await env.DB.prepare(
    'SELECT id, type, caption, permalink, thumb, published_at, local_date, likes, comments, views, reach, saves, shares FROM posts WHERE client = ? ORDER BY published_at DESC LIMIT 18')
    .bind(c.slug).all();
  return {
    client: { slug: c.slug, name: c.name, url: c.url, color: c.color, repo: c.repo, leadEvent: c.leadEvent,
      logo: logoUrl(c.slug, (await env.DB.prepare('SELECT updated_at FROM logos WHERE client = ?').bind(c.slug).first())?.updated_at),
      setup: { ga4: !!c.ga4PropertyId, gsc: !!c.gscSite, clarity: !!c.clarityId, cms: !!c.cms, ig: !!(c.igUserId || c.igUsername || c.fbPageId), ads: !!(c.adAccountId || c.adAccountName), social: c.social !== false, repo: !!c.repo }, platform: c.platform || 'github' },
    kpis: await kpis(env, c.slug),
    series: await series(env, c.slug, ['sessions', 'users', 'leads', 'clicks', 'impressions', 'position', 'reach', 'followers', 'ad_spend', 'ad_messages'], 90),
    posts,
    queries: br.filter((b) => b.kind === 'queries').map((b) => ({ ...b, extra: b.extra ? JSON.parse(b.extra) : null })),
    channels: br.filter((b) => b.kind === 'channels'),
    status: await statusOf(env, c.slug),
    requests: reqs,
    logs,
    links: clientLinks(c),
    formUrl,
    approveUrl,
    cycle: c.social !== false ? await monthCycle(env, c.slug) : null,
    brand: { ...(await withBrand(env, c)).brand, hasCover: !!(await brandOf(env, c.slug))?.hasCover },
  };
}

// ---------- calendario de contenido ----------
const PLAN_STATUSES = ['borrador', 'por_aprobar', 'cambios', 'aprobado', 'programado', 'publicado'];
const PLAN_FORMATS = ['post', 'carrusel', 'reel', 'historia'];
const PLAN_NETWORKS = ['instagram', 'facebook', 'ambas'];
const PLAN_COLS = 'id, client, date, time, network, format, title, series, copy, brief, status, client_comment, reviewed_by, reviewed_at, post_id, created_by, created_at, updated_at';

function cleanPlan(body, partial) {
  const out = {};
  const str = (k, max) => { if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]).slice(0, max); };
  if (body.date !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error('Fecha no válida'); out.date = body.date; }
  if (body.time !== undefined) { if (body.time && !/^\d{2}:\d{2}$/.test(body.time)) throw new Error('Hora no válida'); out.time = body.time || null; }
  if (body.network !== undefined) { if (!PLAN_NETWORKS.includes(body.network)) throw new Error('Red no válida'); out.network = body.network; }
  if (body.format !== undefined) { if (!PLAN_FORMATS.includes(body.format)) throw new Error('Formato no válido'); out.format = body.format; }
  if (body.status !== undefined) { if (!PLAN_STATUSES.includes(body.status)) throw new Error('Estado no válido'); out.status = body.status; }
  str('title', 120); str('copy', 2200); str('series', 80); str('brief', 4000);
  if (body.image !== undefined) {
    if (body.image && !/^data:image\/(jpeg|png|webp);base64,/.test(body.image)) throw new Error('Imagen no válida');
    if (body.image && body.image.length > 1_400_000) throw new Error('La imagen es muy pesada');
    out.image = body.image || null;
  }
  if (!partial && !out.date) throw new Error('Falta la fecha');
  return out;
}

async function planList(env, slug, from, to, withImages = false) {
  const { results } = await env.DB.prepare(
    `SELECT ${PLAN_COLS}, image IS NOT NULL AS has_image, (SELECT COUNT(*) FROM plan_slides s WHERE s.plan_id = content_plan.id) AS slides FROM content_plan WHERE client = ? AND date BETWEEN ? AND ? ORDER BY date, time`)
    .bind(slug, from, to).all();
  return results;
}

async function planImage(env, id) {
  const row = await env.DB.prepare('SELECT image FROM content_plan WHERE id = ?').bind(id).first();
  if (!row?.image) return new Response('', { status: 404 });
  const [, mime, b64] = row.image.match(/^data:([^;]+);base64,(.*)$/) || [];
  if (!b64) return new Response('', { status: 404 });
  return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=300' } });
}

async function slideImage(env, id, n) {
  const row = await env.DB.prepare('SELECT image FROM plan_slides WHERE plan_id = ? AND idx = ?').bind(id, n).first();
  const [, mime, b64] = (row?.image || '').match(/^data:([^;]+);base64,(.*)$/) || [];
  if (!b64) return new Response('', { status: 404 });
  return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=300' } });
}

// Mejor hora para publicar: promedio de reproducciones (o alcance) por hora local, con los últimos 60 posts
async function bestTime(env, slug) {
  const { results } = await env.DB.prepare('SELECT published_at, views, reach FROM posts WHERE client = ? ORDER BY published_at DESC LIMIT 60').bind(slug).all();
  const hourOf = (iso) => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false }).format(new Date(iso)) % 24;
  const by = {};
  for (const p of results) { const v = p.views ?? p.reach; if (v == null || !p.published_at) continue; const h = hourOf(p.published_at); (by[h] ||= []).push(v); }
  const rows = Object.entries(by).filter(([, v]) => v.length >= 2).map(([h, v]) => ({ hour: +h, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
    .sort((a, b) => b.avg - a.avg);
  if (!rows.length) return { hour: null, basis: results.length };
  return { hour: `${String(rows[0].hour).padStart(2, '0')}:00`, basis: results.length, ranking: rows.slice(0, 3).map((r) => ({ hour: `${String(r.hour).padStart(2, '0')}:00`, avg: Math.round(r.avg), n: r.n })) };
}

// ---------- aprobación del cliente ----------
async function handleApprove(request, env, slug, rest, url) {
  const c = getClient(slug);
  const k = url.searchParams.get('k');
  if (!c || !(await checkFormToken(env, slug, k, 'plan'))) return html('<h1>Link no válido</h1>', 404);
  if (!rest && request.method === 'GET') {
    return html(approveHtml.replaceAll('{{CLIENT}}', esc(c.name)).replaceAll('{{LOGO}}', esc(`/logo/${slug}`))
      .replaceAll('{{BASE}}', esc(`/aprobar/${slug}`)).replaceAll('{{K}}', esc(k)));
  }
  if (rest === '/items' && request.method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT id, date, time, network, format, title, copy, status, client_comment, reviewed_by, reviewed_at, image IS NOT NULL AS has_image
       FROM content_plan WHERE client = ? AND status IN ('por_aprobar','cambios','aprobado','programado') AND date >= ? ORDER BY date, time`)
      .bind(slug, shift(today, -3)).all();
    return json({ items: results });
  }
  const img = rest.match(/^\/img\/(\d+)$/);
  if (img && request.method === 'GET') {
    const own = await env.DB.prepare("SELECT 1 FROM content_plan WHERE id = ? AND client = ? AND status != 'borrador'").bind(+img[1], slug).first();
    return own ? planImage(env, +img[1]) : new Response('', { status: 404 });
  }
  const act = rest.match(/^\/(\d+)$/);
  if (act && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return json({ error: 'Escribe tu nombre' }, 400);
    const status = body.action === 'aprobar' ? 'aprobado' : body.action === 'cambios' ? 'cambios' : null;
    if (!status) return json({ error: 'Acción no válida' }, 400);
    const comment = String(body.comment || '').trim().slice(0, 1500);
    if (status === 'cambios' && !comment) return json({ error: 'Cuéntanos qué cambiamos' }, 400);
    const row = await env.DB.prepare(
      "UPDATE content_plan SET status = ?, client_comment = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND client = ? AND status IN ('por_aprobar','cambios','aprobado') RETURNING id, status")
      .bind(status, comment || null, name, now(), now(), +act[1], slug).first();
    return row ? json({ ok: true, item: row }) : json({ error: 'Este post ya no se puede cambiar' }, 409);
  }
  return json({ error: 'No encontrado' }, 404);
}

async function addRequest(env, c, { title, detail, requester, source, createIssueToo }) {
  title = String(title || '').trim().slice(0, 140);
  detail = String(detail || '').trim().slice(0, 4000);
  requester = String(requester || '').trim().slice(0, 120);
  if (!title) throw new Error('Falta el título');
  const ts = now();
  const row = await env.DB.prepare(
    'INSERT INTO requests (client, title, detail, source, requester, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING *')
    .bind(c.slug, title, detail, source, requester, 'nueva', ts, ts).first();
  let warning = null;
  if (createIssueToo && c.repo) {
    try {
      const issue = await createIssue(env, c, row);
      await env.DB.prepare('UPDATE requests SET issue_number = ?, issue_url = ? WHERE id = ?').bind(issue.number, issue.url, row.id).run();
      Object.assign(row, { issue_number: issue.number, issue_url: issue.url });
    } catch (e) { warning = `La solicitud quedó guardada, pero no se creó el issue en GitHub: ${e.message}`; }
  }
  return { request: row, warning };
}

// ---------- logos ----------
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
async function serveLogo(env, slug, request) {
  if (!getClient(slug)) return new Response('', { status: 404 });
  const row = await env.DB.prepare('SELECT mime, data, updated_at FROM logos WHERE client = ?').bind(slug).first();
  const headers = { 'cache-control': 'public, max-age=300', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' };
  if (row) {
    const bytes = Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0));
    return new Response(bytes, { headers: { ...headers, 'content-type': row.mime } });
  }
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(new URL(`/logos/${slug}.png`, request.url));
    if (res.ok) return new Response(res.body, { headers: { ...headers, 'content-type': 'image/png' } });
  }
  return new Response('', { status: 404 });
}

async function uploadLogo(env, c, request, user) {
  const fd = await request.formData();
  const file = fd.get('logo');
  if (!file || typeof file === 'string') throw new Error('Elige un archivo');
  if (!LOGO_TYPES.includes(file.type)) throw new Error('Usa PNG, JPG, WebP o SVG');
  if (file.size > 900_000) throw new Error('El logo pesa más de 900 KB. Expórtalo más ligero.');
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  await env.DB.prepare(
    'INSERT INTO logos (client, mime, data, updated_by, updated_at) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT (client) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
    .bind(c.slug, file.type, btoa(bin), user, now()).run();
  return { ok: true };
}

// ---------- formulario público del cliente ----------
async function handleForm(request, env, slug, url) {
  const c = getClient(slug);
  const k = url.searchParams.get('k');
  if (!c || !(await checkFormToken(env, slug, k))) return html('<h1>Link no válido</h1>', 404);
  const page = (state) => formHtml
    .replaceAll('{{CLIENT}}', esc(c.name))
    .replaceAll('{{LOGO}}', esc(`/logo/${slug}`))
    .replaceAll('{{ACTION}}', esc(`/solicitud/${slug}?k=${k}`))
    .replace('{{STATE}}', state);
  if (request.method === 'GET') return html(page('form'));
  const fd = await request.formData();
  if (fd.get('website')) return html(page('sent')); // trampa para bots
  try {
    await addRequest(env, c, {
      title: fd.get('title'), detail: fd.get('detail'), requester: fd.get('name'),
      source: 'cliente', createIssueToo: env.PUBLIC_ONLY !== '1', // en el Worker de clientes, la tarea la crea el Hub
    });
    return html(page('sent'));
  } catch {
    return html(page('error'), 400);
  }
}

// ---------- router ----------
// Cada cliente en su propia invocación: así ninguno choca con el límite de subrequests de Cloudflare
async function syncAllSplit(env, days) {
  if (!env.SELF) return syncAll(env, days);
  for (const c of CLIENTS) {
    try {
      const token = await formToken(env, c.slug, 'internal');
      await env.SELF.fetch(`https://hub.internal/internal/sync?client=${c.slug}&days=${days}`, { method: 'POST', headers: { 'x-internal': token } });
    } catch { /* el siguiente cliente sigue */ }
  }
}

export default {
  async fetch(request, env, ctx) {
    await ensureSchema(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Público (en Access se configura como "Bypass" para /solicitud/*)
    const form = path.match(/^\/solicitud\/([a-z0-9-]+)$/);
    if (form) return handleForm(request, env, form[1], url);
    const apr = path.match(/^\/aprobar\/([a-z0-9-]+)(\/.*)?$/);
    if (apr) return handleApprove(request, env, apr[1], apr[2] || '', url);
    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
    const lg = path.match(/^\/logo\/([a-z0-9-]+)$/);
    if (lg && request.method === 'GET') return serveLogo(env, lg[1], request);

    // Conector de Claude: /mcp/<llave> (solo en el Worker público; la llave se ve en el Hub)
    const mk = path.match(/^\/mcp\/([a-f0-9]{48})$/);
    if (mk && env.PUBLIC_ONLY === '1') {
      if (mk[1] !== (await mcpKey(env))) return new Response('No autorizado', { status: 401 });
      return handleMcp(request, env, { CLIENTS, withBrand, monthCycle, bestTime, mxToday, shift, formToken });
    }

    // El Worker de clientes (strove-clientes) solo sirve las páginas públicas de arriba
    if (env.PUBLIC_ONLY === '1') return html('<h1>Página no encontrada</h1>', 404);

    // Inspiración de Instagram para el conector (el Worker público no tiene la llave de Meta)
    if (path === '/internal/ig-discovery') {
      if (!(await checkFormToken(env, 'mcp', request.headers.get('x-internal'), 'internal'))) return json({ error: 'No' }, 403);
      try { return json(await discoverInstagram(env, url.searchParams.get('u') || '', Math.min(25, +url.searchParams.get('n') || 12))); }
      catch (e) { return json({ error: e.message }, 400); }
    }

    // Sincronización interna: el cron manda cada cliente en su propia invocación (vía service binding)
    if (path === '/internal/sync' && request.method === 'POST') {
      const slug = url.searchParams.get('client') || '';
      if (!(await checkFormToken(env, slug, request.headers.get('x-internal'), 'internal'))) return json({ error: 'No' }, 403);
      const c = getClient(slug);
      if (!c) return json({ error: 'Cliente no encontrado' }, 404);
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '10', 10), 1), 480);
      return json({ [slug]: await syncClient(env, c, days) });
    }

    // Todo lo demás requiere login
    const user = await accessUser(request, env);
    if (!user) return html('<h1>Sin acceso</h1><p>Entra con tu cuenta autorizada de Strove.</p>', 403);

    try {
      if (path === '/' && request.method === 'GET') return html(dashboardHtml);
      if (path === '/api/me') return json({ email: user, version: env.CF_VERSION_METADATA?.id || null });
      if (path === '/api/overview') return json(await overview(env));

      const cm = path.match(/^\/api\/clients\/([a-z0-9-]+)$/);
      if (cm) {
        const c = getClient(cm[1]);
        return c ? json(await clientDetail(env, c)) : json({ error: 'Cliente no encontrado' }, 404);
      }

      const up = path.match(/^\/api\/clients\/([a-z0-9-]+)\/logo$/);
      if (up && request.method === 'POST') {
        const c = getClient(up[1]);
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        return json(await uploadLogo(env, c, request, user));
      }

      if (path === '/api/plan' && request.method === 'GET') {
        const c = getClient(url.searchParams.get('client'));
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        const from = url.searchParams.get('from') || '2000-01-01', to = url.searchParams.get('to') || '2999-12-31';
        const { results: scheduled } = await env.DB.prepare(
          'SELECT network, id, caption, thumb, local_date, time FROM scheduled_posts WHERE client = ? AND local_date BETWEEN ? AND ? ORDER BY local_date, time')
          .bind(c.slug, from, to).all();
        return json({ items: await planList(env, c.slug, from, to), scheduled });
      }
      if (path === '/api/plan' && request.method === 'POST') {
        const body = await request.json();
        const c = getClient(body.client);
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        const f = cleanPlan(body, false);
        const ts = now();
        const cols = ['client', 'created_by', 'created_at', 'updated_at', ...Object.keys(f)];
        const row = await env.DB.prepare(`INSERT INTO content_plan (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING ${PLAN_COLS}`)
          .bind(c.slug, user, ts, ts, ...Object.values(f)).first();
        return json({ item: row });
      }
      const pm = path.match(/^\/api\/plan\/(\d+)(\/img)?$/);
      if (pm && pm[2] && request.method === 'GET') return planImage(env, +pm[1]);
      if (pm && !pm[2] && request.method === 'PATCH') {
        const f = cleanPlan(await request.json(), true);
        if (!Object.keys(f).length) return json({ error: 'Nada que cambiar' }, 400);
        const row = await env.DB.prepare(`UPDATE content_plan SET ${Object.keys(f).map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ? RETURNING ${PLAN_COLS}`)
          .bind(...Object.values(f), now(), +pm[1]).first();
        return row ? json({ item: row }) : json({ error: 'No existe' }, 404);
      }
      if (pm && !pm[2] && request.method === 'DELETE') {
        await env.DB.batch([env.DB.prepare('DELETE FROM content_plan WHERE id = ?').bind(+pm[1]), env.DB.prepare('DELETE FROM plan_slides WHERE plan_id = ?').bind(+pm[1])]);
        return json({ ok: true });
      }

      const sl = path.match(/^\/api\/plan\/(\d+)\/slides(?:\/(\d+))?$/);
      if (sl && request.method === 'GET' && sl[2] !== undefined) return slideImage(env, +sl[1], +sl[2]);
      if (sl && request.method === 'PUT' && sl[2] !== undefined) {
        const { image } = await request.json();
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(image || '')) return json({ error: 'Imagen no válida' }, 400);
        if (image.length > 1_900_000) return json({ error: 'La lámina es muy pesada' }, 400);
        await env.DB.prepare('INSERT OR REPLACE INTO plan_slides (plan_id, idx, image) VALUES (?, ?, ?)').bind(+sl[1], +sl[2], image).run();
        return json({ ok: true });
      }
      if (sl && request.method === 'DELETE' && sl[2] === undefined) {
        await env.DB.prepare('DELETE FROM plan_slides WHERE plan_id = ?').bind(+sl[1]).run();
        return json({ ok: true });
      }

      if (path === '/api/mcp') {
        const k = await mcpKey(env, request.method === 'POST');
        return json({ url: `${env.CLIENT_URL || 'https://strove-clientes.netoogare.workers.dev'}/mcp/${k}` });
      }

      if (path === '/api/best-time' && request.method === 'GET') {
        const c = getClient(url.searchParams.get('client'));
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        return json(await bestTime(env, c.slug));
      }

      const rd = path.match(/^\/api\/clients\/([a-z0-9-]+)\/report-done$/);
      if (rd && request.method === 'POST') {
        const c = getClient(rd[1]); const { mes, done = true } = await request.json();
        if (!c || !/^\d{4}-\d{2}$/.test(mes || '')) return json({ error: 'Datos no válidos' }, 400);
        if (done) await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`reportdone:${c.slug}:${mes}`, now()).run();
        else await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`reportdone:${c.slug}:${mes}`).run();
        return json({ ok: true });
      }

      if (path === '/api/report-note') {
        const c = getClient(url.searchParams.get('client')); const mes = url.searchParams.get('mes') || '';
        if (!c || !/^\d{4}-\d{2}$/.test(mes)) return json({ error: 'Datos no válidos' }, 400);
        const key = `${url.searchParams.get('kind') === 'intro' ? 'pvintro' : 'note'}:${c.slug}:${mes}`;
        if (request.method === 'PUT') {
          const { note = '' } = await request.json();
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, String(note).slice(0, 8000)).run();
          return json({ ok: true });
        }
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
        return json({ note: row?.value || '' });
      }

      const bk = path.match(/^\/api\/clients\/([a-z0-9-]+)\/brand$/);
      if (bk && request.method === 'PUT') {
        const c = getClient(bk[1]);
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        const b = await request.json();
        const data = { dark: hexOk(b.dark) ? b.dark : null, accent: hexOk(b.accent) ? b.accent : null, light: hexOk(b.light) ? b.light : null, ig: String(b.ig || '').replace(/^@/, '').trim().slice(0, 40) };
        const prev = await env.DB.prepare('SELECT cover FROM brands WHERE client = ?').bind(c.slug).first();
        let cover = prev?.cover || null;
        if (b.cover === null) cover = null;
        else if (typeof b.cover === 'string') {
          if (!/^data:image\/(jpeg|png|webp);base64,/.test(b.cover) || b.cover.length > 1_900_000) return json({ error: 'Foto no válida o muy pesada' }, 400);
          cover = b.cover;
        }
        await env.DB.prepare('INSERT OR REPLACE INTO brands (client, data, cover, updated_at) VALUES (?, ?, ?, ?)').bind(c.slug, JSON.stringify(data), cover, now()).run();
        return json({ brand: (await withBrand(env, c)).brand });
      }
      const bc = path.match(/^\/brand-cover\/([a-z0-9-]+)$/);
      if (bc && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT cover FROM brands WHERE client = ?').bind(bc[1]).first();
        const [, mime, b64] = (row?.cover || '').match(/^data:([^;]+);base64,(.*)$/) || [];
        if (!b64) return new Response('', { status: 404 });
        return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=86400' } });
      }

      const vp = path.match(/^\/vista-previa\/([a-z0-9-]+)$/);
      if (vp && request.method === 'GET') {
        const c = getClient(vp[1]);
        if (!c) return html('<h1>Cliente no encontrado</h1>', 404);
        const t = new Date(); const def = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
        const mes = /^\d{4}-\d{2}$/.test(url.searchParams.get('mes') || '') ? url.searchParams.get('mes') : def;
        const intro = (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`pvintro:${c.slug}:${mes}`).first())?.value || '';
        return html(await renderPreview(env, await withBrand(env, c), mes, { intro }));
      }

      const rp = path.match(/^\/reporte\/([a-z0-9-]+)$/);
      if (rp && request.method === 'GET') {
        const c = getClient(rp[1]);
        if (!c) return html('<h1>Cliente no encontrado</h1>', 404);
        const t = new Date(); const def = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
        const mes = /^\d{4}-\d{2}$/.test(url.searchParams.get('mes') || '') ? url.searchParams.get('mes') : def;
        const raw = (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`note:${c.slug}:${mes}`).first())?.value || '';
        let o = {}; try { o = raw.startsWith('{') ? JSON.parse(raw) : { note: raw }; } catch { o = { note: raw }; }
        if (url.searchParams.get('print') === '1') await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`reportdone:${c.slug}:${mes}`, now()).run();
        return html(await renderReport(env, await withBrand(env, c), mes, o));
      }

      if (path === '/api/sync' && request.method === 'POST') {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '10', 10), 1), 480);
        const slug = url.searchParams.get('client');
        if (slug) {
          const c = getClient(slug);
          if (!c) return json({ error: 'Cliente no encontrado' }, 404);
          return json({ [slug]: await syncClient(env, c, days) });
        }
        await syncAllSplit(env, days);
        return json({ ok: true });
      }

      if (path === '/api/requests' && request.method === 'POST') {
        const body = await request.json();
        const c = getClient(body.client);
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        return json(await addRequest(env, c, { ...body, source: 'interno', requester: body.requester || user, createIssueToo: body.createIssue !== false }));
      }

      const rm = path.match(/^\/api\/requests\/(\d+)$/);
      if (rm && request.method === 'PATCH') {
        const body = await request.json();
        const sets = [], vals = [];
        if (body.status !== undefined) {
          if (!STATUSES.includes(body.status)) return json({ error: 'Estado no válido' }, 400);
          sets.push('status = ?'); vals.push(body.status);
        }
        if (body.preview_url !== undefined) {
          const p = String(body.preview_url).trim();
          if (p && !/^https:\/\//.test(p)) return json({ error: 'El link de vista previa debe empezar con https://' }, 400);
          sets.push('preview_url = ?'); vals.push(p || null);
        }
        if (!sets.length) return json({ error: 'Nada que cambiar' }, 400);
        const row = await env.DB.prepare(`UPDATE requests SET ${sets.join(', ')}, updated_at = ? WHERE id = ? RETURNING *`)
          .bind(...vals, now(), +rm[1]).first();
        return row ? json({ request: row }) : json({ error: 'No existe' }, 404);
      }

      if (path === '/api/requests/refresh' && request.method === 'POST') {
        const c = getClient(url.searchParams.get('client'));
        if (!c) return json({ error: 'Cliente no encontrado' }, 404);
        await refreshRequests(env, c);
        return json({ ok: true });
      }

      return json({ error: 'No encontrado' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (env.PUBLIC_ONLY === '1') return;
    await ensureSchema(env);
    if (event.cron === '0 10 * * *') ctx.waitUntil(syncAllSplit(env, 10));
    else ctx.waitUntil(uptimeAll(env));
  },
};

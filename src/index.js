// Strove Hub · Worker principal
import { CLIENTS, getClient, clientLinks } from './clients.js';
import { accessUser, formToken, checkFormToken } from './auth.js';
import { syncAll, syncClient, uptimeAll, refreshRequests } from './sync.js';
import { createIssue } from './github.js';
import dashboardHtml from './ui/dashboard.html';
import formHtml from './ui/form.html';
import approveHtml from './ui/aprobar.html';

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
      setup: { ga4: !!c.ga4PropertyId, gsc: !!c.gscSite, clarity: !!c.clarityId, cms: !!c.cms, ig: !!c.igUserId },
      plan: { aprobar: planBy[c.slug]?.aprobar || 0, cambios: planBy[c.slug]?.cambios || 0, proximos: planBy[c.slug]?.proximos || 0 },
    });
  }
  return { clients, lastSync: lastSync?.t || null };
}

async function clientDetail(env, c) {
  const { results: br } = await env.DB.prepare('SELECT kind, label, value, extra FROM breakdowns WHERE client = ? ORDER BY kind, rank').bind(c.slug).all();
  const { results: reqs } = await env.DB.prepare('SELECT * FROM requests WHERE client = ? ORDER BY id DESC LIMIT 100').bind(c.slug).all();
  const { results: logs } = await env.DB.prepare('SELECT run_at, source, ok, message FROM sync_log WHERE client = ? ORDER BY id DESC LIMIT 12').bind(c.slug).all();
  let formUrl = null, approveUrl = null;
  try {
    formUrl = `${env.HUB_URL || ''}/solicitud/${c.slug}?k=${await formToken(env, c.slug)}`;
    approveUrl = `${env.HUB_URL || ''}/aprobar/${c.slug}?k=${await formToken(env, c.slug, 'plan')}`;
  } catch { /* sin FORM_SECRET */ }
  const { results: posts } = await env.DB.prepare(
    'SELECT id, type, caption, permalink, thumb, published_at, local_date, likes, comments, views, reach, saves, shares FROM posts WHERE client = ? ORDER BY published_at DESC LIMIT 18')
    .bind(c.slug).all();
  return {
    client: { slug: c.slug, name: c.name, url: c.url, color: c.color, repo: c.repo, leadEvent: c.leadEvent,
      logo: logoUrl(c.slug, (await env.DB.prepare('SELECT updated_at FROM logos WHERE client = ?').bind(c.slug).first())?.updated_at),
      setup: { ga4: !!c.ga4PropertyId, gsc: !!c.gscSite, clarity: !!c.clarityId, cms: !!c.cms, ig: !!c.igUserId, ads: !!c.adAccountId } },
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
  };
}

// ---------- calendario de contenido ----------
const PLAN_STATUSES = ['borrador', 'por_aprobar', 'cambios', 'aprobado', 'programado', 'publicado'];
const PLAN_FORMATS = ['post', 'carrusel', 'reel', 'historia'];
const PLAN_NETWORKS = ['instagram', 'facebook', 'ambas'];
const PLAN_COLS = 'id, client, date, time, network, format, title, copy, status, client_comment, reviewed_by, reviewed_at, post_id, created_by, created_at, updated_at';

function cleanPlan(body, partial) {
  const out = {};
  const str = (k, max) => { if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]).slice(0, max); };
  if (body.date !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error('Fecha no válida'); out.date = body.date; }
  if (body.time !== undefined) { if (body.time && !/^\d{2}:\d{2}$/.test(body.time)) throw new Error('Hora no válida'); out.time = body.time || null; }
  if (body.network !== undefined) { if (!PLAN_NETWORKS.includes(body.network)) throw new Error('Red no válida'); out.network = body.network; }
  if (body.format !== undefined) { if (!PLAN_FORMATS.includes(body.format)) throw new Error('Formato no válido'); out.format = body.format; }
  if (body.status !== undefined) { if (!PLAN_STATUSES.includes(body.status)) throw new Error('Estado no válido'); out.status = body.status; }
  str('title', 120); str('copy', 2200);
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
    `SELECT ${PLAN_COLS}, image IS NOT NULL AS has_image FROM content_plan WHERE client = ? AND date BETWEEN ? AND ? ORDER BY date, time`)
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
      source: 'cliente', createIssueToo: true,
    });
    return html(page('sent'));
  } catch {
    return html(page('error'), 400);
  }
}

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
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

    // Todo lo demás requiere login
    const user = await accessUser(request, env);
    if (!user) return html('<h1>Sin acceso</h1><p>Entra con tu cuenta autorizada de Strove.</p>', 403);

    try {
      if (path === '/' && request.method === 'GET') return html(dashboardHtml);
      if (path === '/api/me') return json({ email: user });
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
        return json({ items: await planList(env, c.slug, url.searchParams.get('from') || '2000-01-01', url.searchParams.get('to') || '2999-12-31') });
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
        await env.DB.prepare('DELETE FROM content_plan WHERE id = ?').bind(+pm[1]).run();
        return json({ ok: true });
      }

      if (path === '/api/sync' && request.method === 'POST') {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '10', 10), 1), 480);
        const slug = url.searchParams.get('client');
        if (slug) {
          const c = getClient(slug);
          if (!c) return json({ error: 'Cliente no encontrado' }, 404);
          return json({ [slug]: await syncClient(env, c, days) });
        }
        return json(await syncAll(env, days));
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
    if (event.cron === '0 10 * * *') ctx.waitUntil(syncAll(env, 10));
    else ctx.waitUntil(uptimeAll(env));
  },
};

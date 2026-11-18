// Recolección: corre sola cada noche (cron) o a mano desde el Hub.
import { CLIENTS } from './clients.js';
import { fetchGA4, fetchGSC } from './google.js';
import { fetchDeploy, issueState, createIssue } from './github.js';
import { fetchInstagram, fetchAds } from './meta.js';

const now = () => new Date().toISOString();

async function log(env, client, source, ok, message) {
  await env.DB.prepare('INSERT INTO sync_log (run_at, client, source, ok, message) VALUES (?,?,?,?,?)')
    .bind(now(), client, source, ok ? 1 : 0, String(message || '').slice(0, 500)).run();
}

async function saveMetrics(env, client, source, rows) {
  if (!rows.length) return;
  const stmt = env.DB.prepare(
    'INSERT INTO metrics (client, source, date, metric, value) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT (client, source, date, metric) DO UPDATE SET value = excluded.value');
  await env.DB.batch(rows.map((r) => stmt.bind(client, source, r.date, r.metric, r.value)));
}

async function saveBreakdown(env, client, kind, items) {
  const ts = now();
  const stmts = [env.DB.prepare('DELETE FROM breakdowns WHERE client = ? AND kind = ?').bind(client, kind)];
  items.forEach((it, i) => stmts.push(
    env.DB.prepare('INSERT INTO breakdowns (client, kind, rank, label, value, extra, updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(client, kind, i + 1, it.label, it.value, it.extra ? JSON.stringify(it.extra) : null, ts)));
  await env.DB.batch(stmts);
}

async function savePosts(env, client, posts) {
  if (!posts.length) return;
  const ts = now();
  const stmt = env.DB.prepare(
    'INSERT INTO posts (client, id, network, type, caption, permalink, thumb, published_at, local_date, likes, comments, views, reach, saves, shares, updated_at) ' +
    "VALUES (?,?,'instagram',?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (client, id) DO UPDATE SET " +
    'type=excluded.type, caption=excluded.caption, permalink=excluded.permalink, thumb=excluded.thumb, likes=excluded.likes, comments=excluded.comments, ' +
    'views=excluded.views, reach=excluded.reach, saves=excluded.saves, shares=excluded.shares, updated_at=excluded.updated_at');
  await env.DB.batch(posts.map((p) => stmt.bind(client, p.id, p.type, p.caption, p.permalink, p.thumb, p.published_at, p.local_date,
    p.likes, p.comments, p.views, p.reach, p.saves, p.shares, ts)));
}

// Empata lo planeado con lo que ya salió en Instagram (mismo día; si hay varios, el de copy más parecido)
export async function matchPlan(env, client) {
  const { results: plan } = await env.DB.prepare(
    "SELECT id, date, copy FROM content_plan WHERE client = ? AND post_id IS NULL AND network IN ('instagram','ambas') AND status IN ('aprobado','programado','por_aprobar','cambios') AND date <= date('now')")
    .bind(client.slug).all();
  if (!plan.length) return 0;
  const { results: taken } = await env.DB.prepare('SELECT post_id FROM content_plan WHERE client = ? AND post_id IS NOT NULL').bind(client.slug).all();
  const used = new Set(taken.map((t) => t.post_id));
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9áéíóúñü ]/g, '').trim().slice(0, 40);
  let n = 0;
  for (const it of plan) {
    const { results: posts } = await env.DB.prepare('SELECT id, caption FROM posts WHERE client = ? AND local_date = ?').bind(client.slug, it.date).all();
    const free = posts.filter((p) => !used.has(p.id));
    if (!free.length) continue;
    const key = norm(it.copy);
    const best = free.find((p) => key && norm(p.caption).startsWith(key.slice(0, 20))) || free[0];
    used.add(best.id);
    await env.DB.prepare("UPDATE content_plan SET post_id = ?, status = 'publicado', updated_at = ? WHERE id = ?").bind(best.id, now(), it.id).run();
    n++;
  }
  return n;
}

export async function checkUptime(env, client) {
  const t0 = Date.now();
  let status = 0;
  try {
    const res = await fetch(client.url, { redirect: 'follow', cf: { cacheTtl: 0 }, headers: { 'user-agent': 'strove-hub-uptime' } });
    status = res.status;
  } catch { status = 0; }
  await env.DB.prepare(
    'INSERT INTO site_status (client, checked_at, http_status, response_ms, updated_at) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT (client) DO UPDATE SET checked_at = excluded.checked_at, http_status = excluded.http_status, response_ms = excluded.response_ms, updated_at = excluded.updated_at')
    .bind(client.slug, now(), status, Date.now() - t0, now()).run();
  return status;
}

export async function syncDeploy(env, client) {
  const d = await fetchDeploy(env, client);
  await env.DB.prepare(
    'INSERT INTO site_status (client, commit_sha, commit_msg, commit_date, deploy_state, updated_at) VALUES (?,?,?,?,?,?) ' +
    'ON CONFLICT (client) DO UPDATE SET commit_sha = excluded.commit_sha, commit_msg = excluded.commit_msg, commit_date = excluded.commit_date, deploy_state = excluded.deploy_state, updated_at = excluded.updated_at')
    .bind(client.slug, d.sha, d.message, d.date, d.state, now()).run();
}

// Solicitudes que llegaron por el formulario del cliente y aún no tienen tarea en GitHub
export async function createPendingIssues(env, client) {
  if (!client.repo || !env.GITHUB_TOKEN) return;
  const { results } = await env.DB.prepare(
    "SELECT * FROM requests WHERE client = ? AND source = 'cliente' AND issue_number IS NULL AND status = 'nueva' ORDER BY id LIMIT 10")
    .bind(client.slug).all();
  for (const r of results) {
    const issue = await createIssue(env, client, r);
    await env.DB.prepare('UPDATE requests SET issue_number = ?, issue_url = ?, updated_at = ? WHERE id = ?').bind(issue.number, issue.url, now(), r.id).run();
  }
}

export async function refreshRequests(env, client) {
  await createPendingIssues(env, client);
  const { results } = await env.DB.prepare(
    "SELECT id, issue_number, status FROM requests WHERE client = ? AND issue_number IS NOT NULL AND status NOT IN ('publicada','descartada')")
    .bind(client.slug).all();
  for (const r of results) {
    const st = await issueState(env, client, r.issue_number);
    if (st && st !== r.status) {
      await env.DB.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').bind(st, now(), r.id).run();
    }
  }
}

// days: cuántos días hacia atrás pedir. La primera vez conviene 90 para tener historial.
export async function syncClient(env, client, days = 10) {
  const out = [];
  // Cliente nuevo (sin datos): trae 90 días de historial
  const has = await env.DB.prepare('SELECT 1 FROM metrics WHERE client = ? LIMIT 1').bind(client.slug).first();
  if (!has) days = Math.max(days, 90);
  const step = async (source, fn) => {
    try { await fn(); await log(env, client.slug, source, true, 'ok'); out.push({ source, ok: true }); }
    catch (e) { await log(env, client.slug, source, false, e.message); out.push({ source, ok: false, error: e.message }); }
  };
  if (client.ga4PropertyId) await step('ga4', async () => {
    const { rows, channels } = await fetchGA4(env, client, days);
    await saveMetrics(env, client.slug, 'ga4', rows);
    await saveBreakdown(env, client.slug, 'channels', channels);
  });
  if (client.gscSite) await step('gsc', async () => {
    const { rows, queries } = await fetchGSC(env, client, days);
    await saveMetrics(env, client.slug, 'gsc', rows);
    await saveBreakdown(env, client.slug, 'queries', queries);
  });
  if (client.igUserId) await step('instagram', async () => {
    const { rows, posts } = await fetchInstagram(env, client, days);
    await saveMetrics(env, client.slug, 'ig', rows);
    await savePosts(env, client.slug, posts);
    await matchPlan(env, client);
  });
  if (client.adAccountId) await step('pauta', async () => {
    const { rows } = await fetchAds(env, client, Math.min(days, 90));
    await saveMetrics(env, client.slug, 'ads', rows);
  });
  if (client.repo) {
    await step('github', () => syncDeploy(env, client));
    await step('solicitudes', () => refreshRequests(env, client));
  }
  if (client.url) await step('uptime', () => checkUptime(env, client));
  return out;
}

export async function syncAll(env, days) {
  const result = {};
  for (const c of CLIENTS) result[c.slug] = await syncClient(env, c, days);
  return result;
}

export async function uptimeAll(env) {
  for (const c of CLIENTS) {
    if (c.url) await checkUptime(env, c);
    try { await createPendingIssues(env, c); } catch { /* se reintenta en la siguiente hora */ }
  }
}

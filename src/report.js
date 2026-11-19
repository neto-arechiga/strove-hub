// Reporte mensual por cliente: una página HTML lista para "Guardar como PDF" (tamaño carta).
// Estilo editorial (como las parrillas de Strove) con los colores de la marca del cliente.

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d }));
const money = (v) => (v == null ? '—' : '$' + Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 }));
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

export function monthRange(mes) {
  const [y, m] = mes.split('-').map(Number);
  const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-${pad(lastDay(y, m))}`;
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return {
    y, m, from, to, label: `${cap(MESES[m - 1])}`, prevLabel: MESES[pm - 1], nextLabel: MESES[nm - 1],
    prev: [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`],
    next: [`${ny}-${pad(nm)}-01`, `${ny}-${pad(nm)}-${pad(lastDay(ny, nm))}`],
  };
}

async function sums(env, slug, [a, b]) {
  const { results } = await env.DB.prepare(
    'SELECT metric, SUM(value) AS s, AVG(value) AS av, COUNT(*) AS n FROM metrics WHERE client = ? AND date BETWEEN ? AND ? GROUP BY metric')
    .bind(slug, a, b).all();
  const o = {};
  for (const r of results) o[r.metric] = r.metric === 'position' ? r.av : r.s;
  return o;
}
const followersAt = (env, slug, d) => env.DB.prepare("SELECT value FROM metrics WHERE client = ? AND metric = 'followers' AND date <= ? ORDER BY date DESC LIMIT 1").bind(slug, d).first();

function delta(cur, prev, { invert = false, pts = false } = {}) {
  if (cur == null || prev == null || (!pts && !prev)) return '<span class="dl flat">sin comparación</span>';
  const diff = pts ? cur - prev : ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(diff) < 0.5) return '<span class="dl flat">igual que el mes pasado</span>';
  const good = invert ? diff < 0 : diff > 0;
  const txt = pts ? `${diff > 0 ? '+' : ''}${nf(diff, 1)} lugares` : `${diff > 0 ? '+' : ''}${nf(diff)}%`;
  return `<span class="dl ${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${txt}</span>`;
}

function lineChart(dates, vals, color) {
  const W = 640, H = 150, P = 8;
  const pts = vals.map((v) => v ?? 0); const max = Math.max(1, ...pts);
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, pts.length - 1);
  const y = (v) => H - P - (v / max) * (H - 2 * P - 14);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${d}L${x(pts.length - 1)},${H - P}L${x(0)},${H - P}Z`;
  const ticks = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].map((i) => `<text x="${x(i)}" y="${H + 12}" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${esc(+dates[i]?.slice(8, 10))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H + 16}" class="chart"><path d="${area}" fill="${color}" opacity=".07"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>${ticks}</svg>`;
}

const CHANNEL = { 'Organic Search': 'Google orgánico', 'Direct': 'Directo', 'Organic Social': 'Redes sociales', 'Paid Social': 'Pauta en redes', 'Referral': 'Otros sitios', 'Paid Search': 'Google Ads', 'Email': 'Correo', 'Unassigned': 'Sin clasificar', 'Organic Video': 'Video', 'Organic Maps': 'Google Maps', 'Cross-network': 'Campañas mixtas', 'AI Assistant': 'Asistentes de IA (ChatGPT, etc.)' };

export async function renderReport(env, c, mes, opts = {}) {
  const r = monthRange(mes);
  // Mes en curso: se compara contra los mismos días del mes anterior (no contra el mes completo)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  r.partial = today <= r.to;
  if (r.partial) {
    const day = Math.max(1, +today.slice(8, 10) - 1); // hasta ayer (el día de hoy aún no termina)
    r.to = `${mes}-${pad(day)}`;
    r.prev[1] = `${r.prev[0].slice(0, 8)}${pad(Math.min(day, +r.prev[1].slice(8, 10)))}`;
    r.days = day;
  }
  const vs = r.partial ? `los mismos días de ${r.prevLabel}` : r.prevLabel;
  const [cur, prev] = await Promise.all([sums(env, c.slug, [r.from, r.to]), sums(env, c.slug, r.prev)]);
  const [fNow, fPrev] = await Promise.all([followersAt(env, c.slug, r.to), followersAt(env, c.slug, r.prev[1])]);
  const { results: posts } = await env.DB.prepare(
    'SELECT id, type, caption, permalink, thumb, local_date, likes, comments, views, reach, saves, shares FROM posts WHERE client = ? AND local_date BETWEEN ? AND ? ORDER BY local_date')
    .bind(c.slug, r.from, r.to).all();
  const { results: prevPosts } = await env.DB.prepare(
    'SELECT views, likes, comments, saves, shares FROM posts WHERE client = ? AND local_date BETWEEN ? AND ?').bind(c.slug, r.prev[0], r.prev[1]).all();
  const { results: br } = await env.DB.prepare('SELECT kind, label, value, extra FROM breakdowns WHERE client = ? ORDER BY kind, rank').bind(c.slug).all();
  const { results: daily } = await env.DB.prepare(
    "SELECT date, value FROM metrics WHERE client = ? AND metric = 'sessions' AND date BETWEEN ? AND ? ORDER BY date").bind(c.slug, r.from, r.to).all();
  const { results: next } = await env.DB.prepare(
    'SELECT id, date, title, format, image IS NOT NULL AS has_image, updated_at FROM content_plan WHERE client = ? AND date BETWEEN ? AND ? ORDER BY date, time')
    .bind(c.slug, r.next[0], r.next[1]).all();

  const theme = { bg: c.report?.bg || '#0A0A0A', accent: c.report?.accent || c.color || '#534AB7' };
  const strong = c.report?.bg || c.color || '#0A0A0A';
  const inter = (p) => (p.likes || 0) + (p.comments || 0) + (p.saves || 0) + (p.shares || 0);
  const ig = {
    views: posts.reduce((a, p) => a + (p.views || 0), 0), pviews: prevPosts.reduce((a, p) => a + (p.views || 0), 0),
    inter: posts.reduce((a, p) => a + inter(p), 0), pinter: prevPosts.reduce((a, p) => a + inter(p), 0),
    saves: posts.reduce((a, p) => a + (p.saves || 0), 0), shares: posts.reduce((a, p) => a + (p.shares || 0), 0),
  };
  const hasGA = cur.sessions != null, hasGSC = cur.clicks != null, hasIG = posts.length > 0 || cur.reach != null || fNow, hasAds = cur.ad_spend != null;
  const channels = br.filter((b) => b.kind === 'channels').slice(0, 6);
  const queries = br.filter((b) => b.kind === 'queries').slice(0, 8).map((b) => ({ ...b, extra: b.extra ? JSON.parse(b.extra) : {} }));
  const top = [...posts].sort((a, b) => (b.views ?? b.reach ?? 0) - (a.views ?? a.reach ?? 0)).slice(0, 3);

  // Lo más importante (automático)
  const bullets = [];
  const pct = (a, b) => (a != null && b ? Math.round(((a - b) / b) * 100) : null);
  if (hasIG && fNow) bullets.push(`La cuenta ${r.partial ? 'va en' : 'cerró el mes con'} <b>${nf(fNow.value)} seguidores</b>${fPrev ? ` (${fNow.value - fPrev.value >= 0 ? '+' : ''}${nf(fNow.value - fPrev.value)} contra ${vs})` : ''}.`);
  if (hasIG && cur.reach) { const p = pct(cur.reach, prev.reach); bullets.push(`El alcance en Instagram sumó <b>${nf(cur.reach)}</b>${p != null ? `, ${p >= 0 ? `${p}% más` : `${Math.abs(p)}% menos`} que en ${vs}` : ''}.`); }
  if (top[0] && (top[0].views || top[0].reach)) bullets.push(`El post con mejor resultado fue <b>“${esc(firstLine(top[0].caption))}”</b> con ${nf(top[0].views ?? top[0].reach)} ${top[0].views != null ? 'reproducciones' : 'cuentas alcanzadas'}.`);
  if (hasGA) { const p = pct(cur.sessions, prev.sessions); bullets.push(`El sitio recibió <b>${nf(cur.sessions)} visitas</b>${p != null ? ` (${p >= 0 ? '+' : ''}${p}% contra ${vs})` : ''}${cur.leads ? ` y generó <b>${nf(cur.leads)} contactos</b>` : ''}.`); }
  if (hasGSC) bullets.push(`En Google apareció <b>${nf(cur.impressions)} veces</b> y recibió <b>${nf(cur.clicks)} clics</b>.`);
  if (hasAds) bullets.push(`Se invirtieron <b>${money(cur.ad_spend)}</b> en pauta${cur.ad_messages ? `, que trajeron <b>${nf(cur.ad_messages)} conversaciones</b>` : ''}.`);

  const tile = (label, value, d, hint = '') => `<div class="tile"><div class="tl">${label}</div><div class="tv">${value}</div>${d || ''}${hint ? `<div class="th">${hint}</div>` : ''}</div>`;
  const pageHead = (eyebrow, title) => `<div class="ph"><div class="eb">${eyebrow}</div><h2>${title}</h2></div>`;
  const foot = (n) => `<div class="foot"><span>${esc(c.name)} · ${r.label} ${r.y}${r.partial ? ` · al ${r.days}` : ''}</span><span>Strove · ${n}</span></div>`;
  let pn = 1;
  const pages = [];

  // 1 · Portada
  pages.push(`<section class="page cover" style="background:${theme.bg}">
    <img class="clogo" src="/logo/${esc(c.slug)}" alt="${esc(c.name)}">
    <div class="cv-mid">
      <div class="cv-eb">Reporte mensual</div>
      <h1>${r.label} <i style="color:${theme.accent}">${r.y}</i></h1>
      <p>Resultados de ${[hasGA || hasGSC ? 'sitio web y Google' : null, hasIG ? 'Instagram' : null, hasAds ? 'pauta' : null].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' y $1')} de ${esc(c.name)}${r.partial ? `, del 1 al ${r.days} de ${MESES[r.m - 1]} (mes en curso)` : ''}, comparados contra ${vs}.</p>
    </div>
    <div class="cv-foot"><span>Preparado por</span><img src="/strove-logo.png" alt="Strove"></div>
  </section>`);

  // 2 · Resumen
  const sumTiles = [
    hasIG && fNow ? tile('Seguidores', nf(fNow.value), delta(fNow.value, fPrev?.value)) : null,
    hasIG && cur.reach != null ? tile('Alcance', nf(cur.reach), delta(cur.reach, prev.reach)) : null,
    hasIG && posts.length ? tile('Reproducciones de posts', nf(ig.views), delta(ig.views, ig.pviews)) : null,
    hasGA ? tile('Visitas al sitio', nf(cur.sessions), delta(cur.sessions, prev.sessions)) : null,
    hasGA && c.leadEvent ? tile('Contactos desde el sitio', nf(cur.leads || 0), delta(cur.leads, prev.leads)) : null,
    hasGSC ? tile('Clics desde Google', nf(cur.clicks), delta(cur.clicks, prev.clicks)) : null,
    hasAds ? tile('Inversión en pauta', money(cur.ad_spend), delta(cur.ad_spend, prev.ad_spend, { invert: true })) : null,
  ].filter(Boolean).slice(0, 6);
  pages.push(`<section class="page">${pageHead('Resumen', 'El mes en números')}
    <div class="tiles t${sumTiles.length > 4 ? 3 : 2}">${sumTiles.join('')}</div>
    ${bullets.length ? `<div class="block"><div class="eb">Lo más importante</div><ul class="bul">${bullets.map((b) => `<li>${b}</li>`).join('')}</ul></div>` : ''}
    ${opts.note ? `<div class="block note" style="border-color:${strong}"><div class="eb">Lectura de Strove</div><p>${esc(opts.note).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p></div>` : ''}
    ${foot(++pn)}</section>`);

  // 3 · Instagram
  if (hasIG) {
    pages.push(`<section class="page">${pageHead('Instagram', 'Así le fue a la cuenta')}
      <div class="tiles t3">
        ${tile('Publicaciones del mes', nf(posts.length))}
        ${tile('Interacciones', nf(ig.inter), delta(ig.inter, ig.pinter), 'Likes, comentarios, guardados y compartidos')}
        ${tile('Guardados y compartidos', nf(ig.saves + ig.shares), '', 'La señal más fuerte de contenido útil')}
      </div>
      ${top.length ? `<div class="eb mt">Los posts con mejor resultado</div>
      <div class="top">${top.map((p, i) => `<div class="tp"><div class="ti" style="background-image:url('${esc(p.thumb || '')}')"><span class="rk" style="background:${strong}">${i + 1}</span></div>
        <div class="tc">${esc(firstLine(p.caption))}</div>
        <div class="tm"><b>${nf(p.views ?? p.reach)}</b> ${p.views != null ? 'reproducciones' : 'alcance'}<br>♥ ${nf(p.likes)} · 💬 ${nf(p.comments)} · ⤓ ${nf(p.saves)} · ↗ ${nf(p.shares)}</div></div>`).join('')}</div>` : ''}
      ${foot(++pn)}</section>`);
    if (posts.length > 3) {
      pages.push(`<section class="page">${pageHead('Instagram', 'Todo lo publicado en ' + MESES[r.m - 1])}
        <div class="grid">${posts.map((p) => `<div class="gp"><div class="gi" style="background-image:url('${esc(p.thumb || '')}')"></div>
          <div class="gm"><span>${+p.local_date.slice(8, 10)} ${MESES[r.m - 1].slice(0, 3)}</span><b>${nf(p.views ?? p.reach)}</b></div></div>`).join('')}</div>
        <div class="small">Número = reproducciones de cada post (o alcance cuando Instagram no da reproducciones).</div>
        ${foot(++pn)}</section>`);
    }
  }

  // 4 · Sitio web + Google
  if (hasGA || hasGSC) {
    const totalCh = channels.reduce((a, b) => a + b.value, 0) || 1;
    pages.push(`<section class="page">${pageHead('Sitio web y Google', 'Quién llegó al sitio y cómo')}
      <div class="tiles t3">
        ${hasGA ? tile('Visitas', nf(cur.sessions), delta(cur.sessions, prev.sessions)) : ''}
        ${hasGA ? tile('Personas', nf(cur.users), delta(cur.users, prev.users)) : ''}
        ${hasGA && c.leadEvent ? tile('Contactos', nf(cur.leads || 0), delta(cur.leads, prev.leads), 'Clics a WhatsApp desde el sitio') : ''}
        ${hasGSC ? tile('Apariciones en Google', nf(cur.impressions), delta(cur.impressions, prev.impressions)) : ''}
        ${hasGSC ? tile('Clics desde Google', nf(cur.clicks), delta(cur.clicks, prev.clicks)) : ''}
        ${hasGSC ? tile('Posición promedio', nf(cur.position, 1), delta(cur.position, prev.position, { invert: true, pts: true }), 'Entre más bajo, más arriba aparece') : ''}
      </div>
      ${daily.length > 3 ? `<div class="eb mt">Visitas por día</div>${lineChart(daily.map((x) => x.date), daily.map((x) => x.value), strong)}` : ''}
      <div class="two">
        ${channels.length ? `<div><div class="eb">De dónde llegan <span class="lt">· últimos 28 días</span></div>${channels.map((b) => `<div class="bar"><span>${esc(CHANNEL[b.label] || b.label)}</span><i><em style="width:${(b.value / channels[0].value) * 100}%;background:${strong}"></em></i><b>${Math.round((b.value / totalCh) * 100)}%</b></div>`).join('')}</div>` : ''}
        ${queries.length ? `<div><div class="eb">Lo que buscan en Google <span class="lt">· últimos 28 días</span></div><table class="q">${queries.map((q) => `<tr><td>${esc(q.label)}</td><td>${nf(q.value)} clics</td></tr>`).join('')}</table></div>` : ''}
      </div>
      ${foot(++pn)}</section>`);
  }

  // 5 · Pauta
  if (hasAds) {
    pages.push(`<section class="page">${pageHead('Pauta en Meta', 'Lo que se invirtió y lo que regresó')}
      <div class="tiles t2">
        ${tile('Inversión', money(cur.ad_spend), delta(cur.ad_spend, prev.ad_spend, { invert: true }))}
        ${cur.ad_clicks != null ? tile('Clics', nf(cur.ad_clicks), delta(cur.ad_clicks, prev.ad_clicks)) : ''}
        ${tile('Conversaciones', nf(cur.ad_messages || 0), delta(cur.ad_messages, prev.ad_messages), 'Mensajes que iniciaron por un anuncio')}
        ${cur.ad_clicks ? tile('Costo por clic', '$' + nf(cur.ad_spend / cur.ad_clicks, 2), '', 'Pesos mexicanos') : ''}
      </div>
      ${cur.ad_messages ? `<div class="block"><div class="eb">Costo por conversación</div><div class="big" style="color:${strong}">$${nf(cur.ad_spend / cur.ad_messages, 0)} <span>MXN</span></div></div>` : ''}
      ${foot(++pn)}</section>`);
  }

  // 6 · Lo que viene
  if (next.length) {
    pages.push(`<section class="page">${pageHead('Lo que viene', cap(r.nextLabel) + ' en Instagram')}
      <div class="next">${next.slice(0, 12).map((n) => `<div class="np">${n.has_image ? `<div class="ni" style="background-image:url('/api/plan/${n.id}/img?v=${encodeURIComponent(n.updated_at)}')"></div>` : '<div class="ni empty"></div>'}
        <div class="nd">${+n.date.slice(8, 10)} de ${r.nextLabel}</div><div class="nt">${esc(n.title || '')}</div></div>`).join('')}</div>
      ${foot(++pn)}</section>`);
  }

  const fileTitle = `${c.name.replace(/[^\p{L}\p{N}]+/gu, '_')}_Reporte_${r.label}_${r.y}`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${esc(fileTitle)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
@page{size:letter;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#d9d6cf;font-family:Inter,system-ui,sans-serif;color:#1b1b1b;font-size:10.5pt;line-height:1.5}
.page{width:8.5in;height:11in;margin:24px auto;background:#F8F6F1;position:relative;overflow:hidden;padding:.75in .72in .9in;page-break-after:always;break-after:page;box-shadow:0 6px 30px rgba(0,0,0,.18)}
.cover{color:#F3EFE6;display:flex;flex-direction:column;justify-content:space-between}
.clogo{height:64px;max-width:240px;object-fit:contain;object-position:left;filter:brightness(0) invert(.95)}
.cv-eb{font-size:8.5pt;letter-spacing:.28em;text-transform:uppercase;opacity:.7;margin-bottom:14px}
.cover h1{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:64pt;line-height:1}
.cover h1 i{font-style:italic}
.cover p{max-width:4.4in;margin-top:22px;font-size:11pt;opacity:.85}
.cv-foot{display:flex;align-items:center;gap:14px;font-size:8pt;letter-spacing:.22em;text-transform:uppercase;opacity:.75}
.cv-foot img{height:20px;filter:brightness(0) invert(.95)}
.ph{margin-bottom:26px}.eb{font-size:7.5pt;letter-spacing:.24em;text-transform:uppercase;color:#6d6a63;font-weight:600}
.eb .lt{letter-spacing:.1em;font-weight:400;text-transform:none}
h2{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:30pt;line-height:1.1;margin-top:6px}
.tiles{display:grid;gap:12px}.t2{grid-template-columns:1fr 1fr}.t3{grid-template-columns:1fr 1fr 1fr}
.tile{background:#fff;border:1px solid #e7e2d8;border-radius:12px;padding:16px 16px 14px}
.tl{font-size:8pt;color:#6d6a63;font-weight:500}.tv{font-family:'Cormorant Garamond',serif;font-size:30pt;font-weight:600;line-height:1.15;margin:4px 0 2px}
.th{font-size:7.5pt;color:#8a867e;margin-top:4px}
.dl{font-size:8pt;font-weight:600}.dl.up{color:#2f7a4d}.dl.down{color:#b04a2f}.dl.flat{color:#8a867e;font-weight:500}
.block{margin-top:26px}.bul{list-style:none;margin-top:10px}.bul li{padding:9px 0 9px 18px;border-bottom:1px solid #e7e2d8;position:relative}
.bul li:before{content:'';position:absolute;left:2px;top:16px;width:6px;height:6px;border-radius:50%;background:#1b1b1b}
.note{border-left:3px solid;padding:4px 0 4px 16px}.note p{margin-top:8px}
.mt{margin-top:26px;margin-bottom:10px}
.top{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.ti{aspect-ratio:4/5;border-radius:10px;background:#e7e2d8 center/cover;position:relative}
.rk{position:absolute;top:8px;left:8px;color:#fff;font-weight:600;font-size:9pt;width:22px;height:22px;border-radius:50%;display:grid;place-items:center}
.tc{font-size:8.5pt;font-weight:600;margin-top:8px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tm{font-size:8pt;color:#55524b;margin-top:4px}.tm b{color:#1b1b1b;font-size:10pt}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.gi{aspect-ratio:4/5;border-radius:8px;background:#e7e2d8 center/cover}
.gm{display:flex;justify-content:space-between;font-size:7.5pt;color:#6d6a63;margin-top:4px}.gm b{color:#1b1b1b}
.small{font-size:7.5pt;color:#8a867e;margin-top:12px}
.chart{width:100%;height:auto;margin-top:4px}.chart text{font-size:9px;fill:#8a867e;font-family:Inter}
.two{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:26px}
.bar{display:grid;grid-template-columns:1.3fr 1fr 34px;gap:8px;align-items:center;font-size:8.5pt;margin-top:9px}
.bar i{height:7px;background:#ece7dd;border-radius:4px;overflow:hidden;display:block}.bar em{display:block;height:100%;border-radius:4px}.bar b{text-align:right}
.q{width:100%;border-collapse:collapse;margin-top:6px;font-size:8.5pt}.q td{padding:7px 0;border-bottom:1px solid #e7e2d8}.q td+td{text-align:right;color:#55524b;white-space:nowrap}
.big{font-family:'Cormorant Garamond',serif;font-size:44pt;font-weight:600}.big span{font-size:14pt}
.next{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.ni{aspect-ratio:4/5;border-radius:8px;background:#e7e2d8 center/cover}.nd{font-size:7.5pt;color:#6d6a63;margin-top:6px;text-transform:uppercase;letter-spacing:.12em}
.nt{font-size:8.5pt;font-weight:600;line-height:1.3;margin-top:2px}
.foot{position:absolute;left:.72in;right:.72in;bottom:.45in;display:flex;justify-content:space-between;font-size:7pt;letter-spacing:.18em;text-transform:uppercase;color:#9a968d}
.bar-top{position:sticky;top:0;z-index:5;background:#1b1b1b;color:#fff;display:flex;gap:14px;align-items:center;justify-content:center;padding:12px;font-size:10pt}
.bar-top button{background:#fff;color:#1b1b1b;border:0;border-radius:999px;padding:9px 18px;font-weight:600;font-size:10pt;cursor:pointer}
.bar-top span{opacity:.75}
@media print{body{background:none}.page{margin:0;box-shadow:none}.bar-top{display:none}}
</style></head><body>
<div class="bar-top"><button onclick="window.print()">Descargar PDF</button><span>En la ventana que se abre, elige <b>“Guardar como PDF”</b>.</span></div>
${pages.join('\n')}
<script>
// Espera a que carguen fuentes e imágenes; si viene con ?print=1 abre el diálogo de guardado
const imgs=[...document.querySelectorAll('[style*="background-image"]')].map(e=>(e.style.backgroundImage.match(/url\\(["']?(.*?)["']?\\)/)||[])[1]).filter(Boolean);
Promise.all([document.fonts.ready,...imgs.map(u=>new Promise(r=>{const i=new Image();i.onload=i.onerror=r;i.src=u;}))]).then(()=>{if(new URLSearchParams(location.search).get('print')==='1')setTimeout(()=>window.print(),300);});
</script></body></html>`;
}

function firstLine(s) {
  const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || 'Post';
  return t.length > 70 ? t.slice(0, 68) + '…' : t;
}

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

  // ---------- presentación editorial ----------
  const A = theme.accent, INK = '#151515';
  const mesTxt = MESES[r.m - 1];
  const dTxt = (cur_, prev_, o = {}) => { // variación en texto corrido, estilo revista
    if (cur_ == null || prev_ == null || (!o.pts && !prev_)) return '';
    const diff = o.pts ? cur_ - prev_ : ((cur_ - prev_) / Math.abs(prev_)) * 100;
    if (Math.abs(diff) < 0.5) return `<span class="dv">igual que ${esc(vs)}</span>`;
    const good = o.invert ? diff < 0 : diff > 0;
    const t = o.pts ? `${diff > 0 ? '+' : '−'}${nf(Math.abs(diff), 1)} lugares` : `${diff > 0 ? '+' : '−'}${nf(Math.abs(diff))}%`;
    return `<span class="dv ${good ? 'g' : 'b'}">${t} <i>vs. ${esc(vs)}</i></span>`;
  };
  const ledger = (rows) => `<div class="ledger">${rows.filter(Boolean).map(([l, v, d, h]) => `<div class="lr"><div class="ll">${l}${h ? `<small>${h}</small>` : ''}</div><div class="lv">${v}${d || ''}</div></div>`).join('')}</div>`;
  const folio = (n, sec) => `<div class="folio"><span>${esc(c.name)} — ${esc(cap(mesTxt))} ${r.y}${r.partial ? ` (al ${r.days})` : ''}</span><span>${sec ? esc(sec) + ' · ' : ''}${String(n).padStart(2, '0')}</span></div>`;
  const chap = (num, name) => `<div class="chap"><span class="cn">${num}</span><span class="cl"></span><span class="ct">${name}</span></div>`;
  const img = (p) => (p?.thumb ? `background-image:url('${esc(p.thumb)}')` : '');
  let pn = 1, ch = 0;
  const pages = [];
  const hero = top[0] || posts[posts.length - 1];
  const scope = [hasGA || hasGSC ? 'sitio web y Google' : null, hasIG ? 'Instagram' : null, hasAds ? 'pauta' : null].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' y $1');

  // 1 · Portada: foto del mejor post a sangre + bloque de color de la marca
  pages.push(`<section class="page cover" style="background:${theme.bg}">
    ${hero?.thumb ? `<div class="cv-photo" style="${img(hero)}"></div><div class="cv-fade" style="background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,0) 30%,${theme.bg} 100%)"></div>` : ''}
    <div class="cv-top"><img class="clogo" src="/logo/${esc(c.slug)}" alt="${esc(c.name)}"><span class="cv-issue">Reporte mensual<br>N.º ${pad(r.m)} · ${r.y}</span></div>
    <div class="cv-mid">
      <h1>${esc(cap(mesTxt))}<br><i style="color:${A}">${r.y}</i></h1>
      <div class="cv-rule" style="background:${A}"></div>
      <p>Resultados de ${scope} de ${esc(c.name)}${r.partial ? `, del 1 al ${r.days} de ${mesTxt}` : ''}.</p>
    </div>
    <div class="cv-foot"><span>Preparado por</span><img src="/strove-logo.png" alt="Strove"></div>
  </section>`);

  // 2 · Editorial: la frase del mes + cifras + lo más importante + lectura de Strove
  const lead = hasIG && cur.reach ? `Este mes, el contenido de ${esc(c.name)} sumó <em style="color:${strong}">${nf(cur.reach)}</em> de alcance en Instagram.`
    : hasGA ? `Este mes, <em style="color:${strong}">${nf(cur.sessions)}</em> visitas llegaron al sitio de ${esc(c.name)}.`
    : hasGSC ? `Este mes, ${esc(c.name)} apareció <em style="color:${strong}">${nf(cur.impressions)}</em> veces en Google.` : `El mes de ${esc(c.name)} en números.`;
  const sumRows = [
    hasIG && fNow ? ['Seguidores', nf(fNow.value), dTxt(fNow.value, fPrev?.value)] : null,
    hasIG && cur.reach != null ? ['Alcance', nf(cur.reach), dTxt(cur.reach, prev.reach), 'Suma del alcance diario'] : null,
    hasIG && posts.length ? ['Reproducciones', nf(ig.views), dTxt(ig.views, ig.pviews), `De los ${posts.length} posts del mes`] : null,
    hasGA ? ['Visitas al sitio', nf(cur.sessions), dTxt(cur.sessions, prev.sessions)] : null,
    hasGA && c.leadEvent ? ['Contactos desde el sitio', nf(cur.leads || 0), dTxt(cur.leads, prev.leads)] : null,
    hasGSC ? ['Clics desde Google', nf(cur.clicks), dTxt(cur.clicks, prev.clicks)] : null,
    hasAds ? ['Inversión en pauta', money(cur.ad_spend), dTxt(cur.ad_spend, prev.ad_spend, { invert: true })] : null,
  ].filter(Boolean).slice(0, 6);
  pages.push(`<section class="page">
    <div class="kicker">Editorial</div>
    <h2 class="lead">${lead}</h2>
    <div class="cols">
      <div><div class="sh">En cifras</div>${ledger(sumRows)}</div>
      <div><div class="sh">Lo más importante</div><ol class="hl">${bullets.map((b, i) => `<li><span class="n" style="color:${strong}">${pad(i + 1)}</span><span>${b}</span></li>`).join('')}</ol></div>
    </div>
    ${opts.note ? `<blockquote class="pull"><span class="q" style="color:${A}">“</span><p>${esc(opts.note).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p><cite>— Lectura de Strove</cite></blockquote>` : ''}
    ${folio(++pn, 'Editorial')}</section>`);

  // 3 · Instagram: apertura con el mejor post a media página
  if (hasIG) {
    const n = pad(++ch);
    pages.push(`<section class="page split">
      <div class="sp-img" style="background:${theme.bg}"><div class="sp-ph" style="${img(top[0])}"></div><span class="sp-tag">El post del mes</span></div>
      <div class="sp-txt">
        ${chap(n, 'Instagram')}
        <h2>Lo que más<br><i>conectó</i></h2>
        ${top[0] ? `<p class="dek">“${esc(firstLine(top[0].caption, 120))}”</p>
        <div class="sh">${+top[0].local_date.slice(8, 10)} de ${mesTxt}</div>
        ${ledger([
          [top[0].views != null ? 'Reproducciones' : 'Alcance', nf(top[0].views ?? top[0].reach)],
          ['Me gusta', nf(top[0].likes)], ['Comentarios', nf(top[0].comments)],
          ['Guardados', nf(top[0].saves)], ['Compartidos', nf(top[0].shares)],
        ])}` : '<p class="dek">Todavía no hay posts publicados este mes.</p>'}
        <div class="sh mt">La cuenta en el mes</div>
        ${ledger([
          ['Publicaciones', nf(posts.length)],
          ['Interacciones', nf(ig.inter), dTxt(ig.inter, ig.pinter), 'Me gusta, comentarios, guardados y compartidos'],
          ['Guardados + compartidos', nf(ig.saves + ig.shares), '', 'La señal más fuerte de contenido útil'],
        ])}
      </div>
      ${folio(++pn, 'Instagram')}</section>`);
    if (posts.length > 1) {
      const rest = top.slice(1);
      pages.push(`<section class="page">
        <div class="kicker">Instagram · El feed de ${mesTxt}</div>
        ${rest.length ? `<div class="duo">${rest.map((p, i) => `<figure><div class="fi" style="${img(p)}"></div><figcaption><span class="rk">N.º ${i + 2}</span>${esc(firstLine(p.caption))}<b>${nf(p.views ?? p.reach)} ${p.views != null ? 'reproducciones' : 'de alcance'}</b></figcaption></figure>`).join('')}</div>` : ''}
        <div class="sh mt">Hoja de contactos · ${posts.length} publicaciones</div>
        <div class="contact">${posts.map((p) => `<div class="cs"><div class="ci" style="${img(p)}"></div><div class="cm"><span>${+p.local_date.slice(8, 10)}.${pad(r.m)}</span><b>${nf(p.views ?? p.reach)}</b></div></div>`).join('')}</div>
        <p class="note-s">Cifra = reproducciones de cada publicación (alcance cuando Instagram no da reproducciones).</p>
        ${folio(++pn, 'Instagram')}</section>`);
    }
  }

  // 4 · Sitio web y Google
  if (hasGA || hasGSC) {
    const n = pad(++ch);
    const totalCh = channels.reduce((a, b) => a + b.value, 0) || 1;
    pages.push(`<section class="page">
      ${chap(n, 'Sitio web y Google')}
      <h2 class="lead sm">${hasGA ? `<em style="color:${strong}">${nf(cur.sessions)}</em> visitas${cur.leads && c.leadEvent ? ` y <em style="color:${strong}">${nf(cur.leads)}</em> contactos` : ''} en ${mesTxt}.` : `<em style="color:${strong}">${nf(cur.clicks)}</em> clics desde Google en ${mesTxt}.`}</h2>
      ${daily.length > 3 ? `<div class="chartwrap">${lineChart(daily.map((x) => x.date), daily.map((x) => x.value), strong)}<div class="cap">Visitas por día</div></div>` : ''}
      <div class="cols">
        <div><div class="sh">El sitio</div>${ledger([
          hasGA ? ['Visitas', nf(cur.sessions), dTxt(cur.sessions, prev.sessions)] : null,
          hasGA ? ['Personas', nf(cur.users), dTxt(cur.users, prev.users)] : null,
          hasGA && c.leadEvent ? ['Contactos', nf(cur.leads || 0), dTxt(cur.leads, prev.leads), 'Clics a WhatsApp desde el sitio'] : null,
          hasGSC ? ['Apariciones en Google', nf(cur.impressions), dTxt(cur.impressions, prev.impressions)] : null,
          hasGSC ? ['Clics desde Google', nf(cur.clicks), dTxt(cur.clicks, prev.clicks)] : null,
          hasGSC ? ['Posición promedio', nf(cur.position, 1), dTxt(cur.position, prev.position, { invert: true, pts: true }), 'Entre más bajo, más arriba aparece'] : null,
        ])}</div>
        <div>
          ${channels.length ? `<div class="sh">De dónde llegan <i>· últimos 28 días</i></div><div class="chs">${channels.map((b) => `<div class="chr"><span class="cp">${Math.round((b.value / totalCh) * 100)}<sup>%</sup></span><span class="cnm">${esc(CHANNEL[b.label] || b.label)}</span></div>`).join('')}</div>` : ''}
          ${queries.length ? `<div class="sh mt">Lo que buscan en Google <i>· últimos 28 días</i></div><ol class="qs">${queries.slice(0, 6).map((q) => `<li><span>${esc(q.label)}</span><b>${nf(q.value)}</b></li>`).join('')}</ol>` : ''}
        </div>
      </div>
      ${folio(++pn, 'Sitio web y Google')}</section>`);
  }

  // 5 · Pauta
  if (hasAds) {
    const n = pad(++ch);
    pages.push(`<section class="page">
      ${chap(n, 'Pauta en Meta')}
      <h2 class="lead sm">Se invirtieron <em style="color:${strong}">${money(cur.ad_spend)}</em>${cur.ad_messages ? ` y se abrieron <em style="color:${strong}">${nf(cur.ad_messages)}</em> conversaciones` : ''}.</h2>
      <div class="cols">
        <div><div class="sh">Resultados</div>${ledger([
          ['Inversión', money(cur.ad_spend), dTxt(cur.ad_spend, prev.ad_spend, { invert: true })],
          cur.ad_clicks != null ? ['Clics', nf(cur.ad_clicks), dTxt(cur.ad_clicks, prev.ad_clicks)] : null,
          ['Conversaciones', nf(cur.ad_messages || 0), dTxt(cur.ad_messages, prev.ad_messages), 'Mensajes iniciados por un anuncio'],
        ])}</div>
        <div><div class="sh">Lo que cuesta</div>
          ${cur.ad_messages ? `<div class="bignum" style="color:${strong}">$${nf(cur.ad_spend / cur.ad_messages)}<span>MXN por conversación</span></div>` : ''}
          ${cur.ad_clicks ? `<div class="bignum s">$${nf(cur.ad_spend / cur.ad_clicks, 2)}<span>MXN por clic</span></div>` : ''}
        </div>
      </div>
      ${folio(++pn, 'Pauta')}</section>`);
  }

  // 6 · Lo que viene
  if (next.length) {
    const n = pad(++ch);
    pages.push(`<section class="page">
      ${chap(n, 'Lo que viene')}
      <h2 class="lead sm">${cap(r.nextLabel)} en Instagram: <em style="color:${strong}">${next.length}</em> publicaciones en camino.</h2>
      <div class="next">${next.slice(0, 12).map((x) => `<figure>${x.has_image ? `<div class="ni" style="background-image:url('/api/plan/${x.id}/img?v=${encodeURIComponent(x.updated_at)}')"></div>` : '<div class="ni"></div>'}
        <figcaption><span>${+x.date.slice(8, 10)} ${r.nextLabel.slice(0, 3)}</span>${esc(x.title || '')}</figcaption></figure>`).join('')}</div>
      ${folio(++pn, 'Lo que viene')}</section>`);
  }

  // Contraportada
  pages.push(`<section class="page back" style="background:${theme.bg}">
    <div class="bk"><img src="/strove-logo.png" alt="Strove"><p>Estrategia, diseño y contenido.<br>hola@strove.mx · strove.mx</p></div>
  </section>`);

  const fileTitle = `${c.name.replace(/[^\p{L}\p{N}]+/gu, '_')}_Reporte_${cap(mesTxt)}_${r.y}`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${esc(fileTitle)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
@page{size:letter;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#cfcbc2;font-family:Inter,system-ui,sans-serif;color:${INK};font-size:9.5pt;line-height:1.55}
.page{width:8.5in;height:11in;margin:24px auto;background:#F4F1EA;position:relative;overflow:hidden;padding:.8in .78in 1in;page-break-after:always;break-after:page;box-shadow:0 8px 34px rgba(0,0,0,.2)}
i,em{font-style:italic}
.serif,h1,h2,.lead,.bignum,.lv,.cp,.dek,.pull p{font-family:'Cormorant Garamond',Georgia,serif}
/* portada */
.cover{color:#F3EFE6;padding:0}
.cv-photo{position:absolute;inset:0 0 34% 0;background:#333 center/cover}
.cv-fade{position:absolute;inset:0 0 34% 0}
.cv-top{position:absolute;top:.6in;left:.7in;right:.7in;display:flex;justify-content:space-between;align-items:flex-start}
.clogo{height:54px;max-width:220px;object-fit:contain;object-position:left;filter:brightness(0) invert(.96)}
.cv-issue{font-size:7pt;letter-spacing:.3em;text-transform:uppercase;text-align:right;line-height:1.9;opacity:.9}
.cv-mid{position:absolute;left:.7in;right:.7in;bottom:1.25in}
.cover h1{font-weight:400;font-size:86pt;line-height:.88;letter-spacing:-.01em}
.cover h1 i{font-weight:400}
.cv-rule{width:56px;height:2px;margin:26px 0 16px}
.cover p{max-width:4.2in;font-size:10.5pt;line-height:1.6;opacity:.9}
.cv-foot{position:absolute;left:.7in;right:.7in;bottom:.55in;display:flex;align-items:center;gap:12px;font-size:6.5pt;letter-spacing:.3em;text-transform:uppercase;opacity:.75}
.cv-foot img{height:15px;filter:brightness(0) invert(.96)}
/* tipografía */
.kicker{font-size:7pt;letter-spacing:.32em;text-transform:uppercase;color:#7a766d;margin-bottom:18px}
.lead{font-weight:400;font-size:34pt;line-height:1.08;letter-spacing:-.01em;max-width:6.4in}
.lead.sm{font-size:28pt;margin-top:10px}
.lead em{font-weight:500}
h2{font-weight:400;font-size:40pt;line-height:.98}
.sh{font-size:6.8pt;letter-spacing:.28em;text-transform:uppercase;color:#7a766d;padding-bottom:9px;border-bottom:1px solid ${INK};margin-bottom:2px}
.sh i{letter-spacing:.06em;text-transform:none;font-family:'Cormorant Garamond',serif;font-size:9pt}
.mt{margin-top:22px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:.45in;margin-top:.45in}
.ledger .lr{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;padding:10px 0 9px;border-bottom:1px solid #d9d4c8}
.ll{font-size:8.5pt;color:#3a3833}.ll small{display:block;font-size:7pt;color:#8d897f;margin-top:1px}
.lv{font-size:21pt;font-weight:500;line-height:1;text-align:right;white-space:nowrap}
.dv{display:block;font-family:Inter,sans-serif;font-size:7pt;font-weight:600;margin-top:4px;letter-spacing:.02em}
.dv i{font-weight:400;color:#8d897f}
.dv.g{color:#2e6b48}.dv.b{color:#a5452c}
.hl{list-style:none}
.hl li{display:grid;grid-template-columns:30px 1fr;gap:6px;padding:10px 0 9px;border-bottom:1px solid #d9d4c8;font-size:8.8pt;line-height:1.5}
.hl .n{font-family:'Cormorant Garamond',serif;font-size:15pt;line-height:1;font-style:italic}
.pull{margin-top:.45in;padding-top:18px;border-top:1px solid ${INK};position:relative}
.pull .q{position:absolute;top:2px;left:-6px;font-family:'Cormorant Garamond',serif;font-size:70pt;line-height:1}
.pull p{font-size:17pt;line-height:1.3;font-style:italic;padding-left:42px;margin-bottom:8px}
.pull cite{display:block;padding-left:42px;font-style:normal;font-size:7pt;letter-spacing:.28em;text-transform:uppercase;color:#7a766d}
.chap{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.cn{font-family:'Cormorant Garamond',serif;font-size:13pt;font-style:italic}
.cl{flex:0 0 40px;height:1px;background:${INK}}
.ct{font-size:7pt;letter-spacing:.32em;text-transform:uppercase}
/* apertura con foto */
.split{padding:0;display:grid;grid-template-columns:47% 53%}
.sp-img{position:relative;display:flex;align-items:center;justify-content:center}
.sp-ph{width:76%;aspect-ratio:4/5;background:#cfc9bb center/cover;box-shadow:0 18px 40px rgba(0,0,0,.35)}
.sp-tag{position:absolute;left:12%;bottom:.55in;color:#F3EFE6;font-size:6.8pt;letter-spacing:.3em;text-transform:uppercase;text-shadow:0 1px 8px rgba(0,0,0,.4)}
.sp-txt{padding:.8in .65in 1in .5in}
.sp-txt h2{margin-bottom:18px}
.dek{font-size:14.5pt;line-height:1.3;font-style:italic;color:#2f2d29;margin-bottom:22px}
/* feed */
.duo{display:grid;grid-template-columns:1fr 1fr;gap:.3in}
.duo .fi{aspect-ratio:4/5;background:#ddd7cb center/cover}
figcaption{font-size:8.3pt;line-height:1.45;margin-top:9px;color:#3a3833}
figcaption .rk{display:block;font-family:'Cormorant Garamond',serif;font-style:italic;font-size:12pt;color:${INK};margin-bottom:2px}
figcaption b{display:block;font-family:'Cormorant Garamond',serif;font-weight:500;font-size:13pt;color:${INK};margin-top:3px}
.contact{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-top:12px}
.ci{aspect-ratio:4/5;background:#ddd7cb center/cover}
.cm{display:flex;justify-content:space-between;font-size:6.6pt;color:#7a766d;margin-top:3px}.cm b{color:${INK};font-weight:600}
.note-s{font-size:6.8pt;color:#8d897f;margin-top:12px;font-style:italic}
/* sitio */
.chartwrap{margin-top:.3in}.chart{width:100%;height:auto}.chart text{font-size:9px;fill:#8d897f;font-family:Inter}
.cap{font-size:6.8pt;letter-spacing:.28em;text-transform:uppercase;color:#7a766d;margin-top:2px}
.chs{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
.chr{display:flex;align-items:baseline;gap:8px;padding:9px 0 7px;border-bottom:1px solid #d9d4c8}
.cp{font-size:24pt;font-weight:500;line-height:1;min-width:58px}.cp sup{font-size:10pt;vertical-align:top}
.cnm{font-size:8pt;color:#3a3833;line-height:1.3}
.qs{list-style:none;counter-reset:q}
.qs li{counter-increment:q;display:grid;grid-template-columns:22px 1fr auto;gap:6px;padding:8px 0 7px;border-bottom:1px solid #d9d4c8;font-size:8.5pt}
.qs li:before{content:counter(q);font-family:'Cormorant Garamond',serif;font-style:italic;font-size:11pt;line-height:1.1}
.qs b{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:12pt}
/* pauta */
.bignum{font-size:58pt;font-weight:500;line-height:1;margin-top:16px}
.bignum.s{font-size:30pt;color:${INK}}
.bignum span{display:block;font-family:Inter,sans-serif;font-size:7pt;letter-spacing:.24em;text-transform:uppercase;color:#7a766d;margin-top:8px;font-weight:500}
/* lo que viene */
.next{display:grid;grid-template-columns:repeat(4,1fr);gap:.22in;margin-top:.4in}
.ni{aspect-ratio:4/5;background:#ddd7cb center/cover}
.next figcaption span{display:block;font-family:'Cormorant Garamond',serif;font-style:italic;font-size:11pt;color:${INK}}
/* contraportada */
.back{display:flex;align-items:center;justify-content:center;color:#F3EFE6}
.bk{text-align:center}.bk img{height:30px;filter:brightness(0) invert(.96)}
.bk p{margin-top:16px;font-size:7pt;letter-spacing:.28em;text-transform:uppercase;line-height:2.1;opacity:.75}
.folio{position:absolute;left:.78in;right:.78in;bottom:.5in;display:flex;justify-content:space-between;font-size:6.5pt;letter-spacing:.24em;text-transform:uppercase;color:#8d897f;border-top:1px solid #d9d4c8;padding-top:10px}
.split .folio{left:calc(47% + .5in);right:.65in}.split .folio span:first-child{display:none}
.bar-top{position:sticky;top:0;z-index:5;background:#151515;color:#fff;display:flex;gap:14px;align-items:center;justify-content:center;padding:12px;font-size:10pt}
.bar-top button{background:#fff;color:#151515;border:0;border-radius:999px;padding:9px 18px;font-weight:600;font-size:10pt;cursor:pointer}
.bar-top span{opacity:.75}
@media print{body{background:none}.page{margin:0;box-shadow:none}.bar-top{display:none}}
</style></head><body>
<div class="bar-top"><button onclick="window.print()">Descargar PDF</button><span>En la ventana que se abre, elige <b>“Guardar como PDF”</b>.</span></div>
${pages.join('\n')}
<script>
const imgs=[...document.querySelectorAll('[style*="background-image"]')].map(e=>(e.style.backgroundImage.match(/url\\(["']?(.*?)["']?\\)/)||[])[1]).filter(Boolean);
Promise.all([document.fonts.ready,...imgs.map(u=>new Promise(r=>{const i=new Image();i.onload=i.onerror=r;i.src=u;}))]).then(()=>{if(new URLSearchParams(location.search).get('print')==='1')setTimeout(()=>window.print(),300);});
</script></body></html>`;
}

function firstLine(s, max = 70) {
  const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || 'Post';
  return t.length > max ? t.slice(0, max - 2) + '…' : t;
}

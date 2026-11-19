// Reporte mensual por cliente, formato presentación 16:9 (como los reportes de Strove).
// Se abre como página web y se guarda como PDF desde el navegador.
import { fetchReportLive } from './meta.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 0) => (v == null || Number.isNaN(+v) ? '—' : Number(v).toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d }));
const kf = (v) => (v == null ? '—' : v >= 10000 ? `${nf(v / 1000, 1).replace(/\.0$/, '')}k` : nf(v)); // 10.5k
const money = (v, d = 0) => (v == null ? '—' : '$' + nf(v, d));
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pctOf = (a, b) => (a != null && b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);
function firstLine(s, max = 60) {
  const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || 'Publicación';
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}

export function monthRange(mes) {
  const [y, m] = mes.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return { y, m, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}`, mes: MESES[m - 1], prevMes: MESES[pm - 1], nextMes: MESES[nm - 1],
    prev: [`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`] };
}
async function sums(env, slug, [a, b]) {
  const { results } = await env.DB.prepare('SELECT metric, SUM(value) AS s, AVG(value) AS av FROM metrics WHERE client = ? AND date BETWEEN ? AND ? GROUP BY metric').bind(slug, a, b).all();
  return Object.fromEntries(results.map((r) => [r.metric, r.metric === 'position' ? r.av : r.s]));
}
const followersAt = (env, slug, d) => env.DB.prepare("SELECT value FROM metrics WHERE client = ? AND metric = 'followers' AND date <= ? ORDER BY date DESC LIMIT 1").bind(slug, d).first();
const lines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);

export async function renderReport(env, c, mes, opts = {}) {
  const r = monthRange(mes);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  r.partial = today <= r.to;
  if (r.partial) { const day = Math.max(1, +today.slice(8, 10) - 1); r.to = `${mes}-${pad(day)}`; r.prev[1] = `${r.prev[0].slice(0, 8)}${pad(Math.min(day, +r.prev[1].slice(8, 10)))}`; }
  r.days = +r.to.slice(8, 10);
  const ABR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const vsTxt = `vs. ${ABR[MESES.indexOf(r.prevMes)]}.`;

  const [cur, prev] = await Promise.all([sums(env, c.slug, [r.from, r.to]), sums(env, c.slug, r.prev)]);
  const [fNow, fPrev] = await Promise.all([followersAt(env, c.slug, r.to), followersAt(env, c.slug, r.prev[1])]);
  const f90 = await env.DB.prepare("SELECT date, value FROM metrics WHERE client = ? AND metric = 'followers' ORDER BY date ASC LIMIT 1").bind(c.slug).first();
  const { results: posts } = await env.DB.prepare('SELECT id, type, caption, thumb, local_date, likes, comments, views, reach, saves, shares FROM posts WHERE client = ? AND local_date BETWEEN ? AND ? ORDER BY local_date').bind(c.slug, r.from, r.to).all();
  const { results: prevPosts } = await env.DB.prepare('SELECT views, reach, likes, comments, saves, shares FROM posts WHERE client = ? AND local_date BETWEEN ? AND ?').bind(c.slug, r.prev[0], r.prev[1]).all();
  const { results: br } = await env.DB.prepare('SELECT kind, label, value, extra FROM breakdowns WHERE client = ? ORDER BY kind, rank').bind(c.slug).all();
  const { results: dReach } = await env.DB.prepare("SELECT date, value FROM metrics WHERE client = ? AND metric = 'reach' AND date BETWEEN ? AND ? ORDER BY date").bind(c.slug, r.from, r.to).all();
  const { results: dSess } = await env.DB.prepare("SELECT date, value FROM metrics WHERE client = ? AND metric = 'sessions' AND date BETWEEN ? AND ? ORDER BY date").bind(c.slug, r.from, r.to).all();
  let live = { cur: {}, prev: {}, demo: null, ads: [] };
  try { live = await fetchReportLive(env, c, r.from, r.to, r.prev[0], r.prev[1]); } catch { /* sin datos en vivo */ }

  // ---- datos combinados ----
  const inter = (p) => (p.likes || 0) + (p.comments || 0) + (p.saves || 0) + (p.shares || 0);
  const sum = (arr, f) => arr.reduce((a, p) => a + (f(p) || 0), 0);
  const ig = {
    reach: live.cur.reach ?? null, reachPrev: live.prev.reach ?? null, reachDaily: cur.reach ?? null, reachDailyPrev: prev.reach ?? null,
    views: live.cur.views ?? (sum(posts, (p) => p.views) || null), viewsPrev: live.prev.views ?? (sum(prevPosts, (p) => p.views) || null),
    inter: live.cur.total_interactions ?? sum(posts, inter), interPrev: live.prev.total_interactions ?? sum(prevPosts, inter),
    profile: live.cur.profile_views ?? null, profilePrev: live.prev.profile_views ?? null,
    clicks: live.cur.website_clicks ?? null, clicksPrev: live.prev.website_clicks ?? null,
    newF: fNow && fPrev ? fNow.value - fPrev.value : null,
  };
  const reachVal = ig.reach ?? ig.reachDaily, reachPrevVal = ig.reach != null ? ig.reachPrev : ig.reachDailyPrev;
  const hasIG = c.social !== false && (posts.length > 0 || reachVal != null || fNow);
  const hasAds = cur.ad_spend != null && cur.ad_spend > 0;
  const hasGA = cur.sessions != null, hasGSC = cur.clicks != null;
  const convs = hasAds ? cur.ad_messages || 0 : null;
  const cpc = hasAds && convs ? cur.ad_spend / convs : null, cpcPrev = prev.ad_spend && prev.ad_messages ? prev.ad_spend / prev.ad_messages : null;
  const byReach = [...posts].sort((a, b) => (b.reach ?? b.views ?? 0) - (a.reach ?? a.views ?? 0));
  const photos = byReach.map((p) => p.thumb).filter(Boolean);
  if (c.coverUrl) photos.unshift(c.coverUrl);
  const photo = (i) => photos.length ? photos[i % photos.length] : null;
  const queries = br.filter((b) => b.kind === 'queries').slice(0, 6);
  const channels = br.filter((b) => b.kind === 'channels').slice(0, 5);

  // ---- tema de la marca ----
  const T = { dark: c.report?.bg || '#1F2B26', hi: c.report?.accent || c.color || '#BDBAB2', warm: c.report?.warm || c.report?.bg || c.color || '#1F2B26', muted: c.report?.muted || c.report?.accent || '#BDBAB2', cream: c.report?.cream || '#F1EFEA', card: c.report?.card || '#E6E3DC' };
  const label = `${esc(c.name)} · Reporte ${r.mes} ${r.y}`.toUpperCase();
  const pill = (txt, kind = 'dk') => `<span class="pill ${kind}">${txt}</span>`;
  const dPill = (a, b, o = {}) => { const p = pctOf(a, b); if (p == null) return ''; const t = `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}%`; return pill(o.long ? `${t} ${vsTxt}` : t, o.kind || 'dk'); };
  const head = (num, kicker, title, onDark) => `<div class="hd"><div class="kick ${onDark ? 'hi' : ''}"><i></i>${num} · ${esc(kicker)}</div><img class="mini ${onDark ? 'inv' : ''}" src="/logo/${esc(c.slug)}" alt=""></div><h2>${title}</h2>`;
  const foot = (src) => `<div class="ft"><span>${label}${src ? ' · FUENTE: ' + src : ''}</span><span class="pn"></span></div>`;
  const opener = (num, total, title, desc, items, img) => `<section class="pg op" style="background:${T.dark}">${img ? `<div class="bgph" style="background-image:url('${esc(img)}')"></div><div class="tint" style="background:${T.dark}"></div>` : ''}
    <div class="top"><img class="lg inv" src="/logo/${esc(c.slug)}" alt=""><span class="tr">Reporte ${r.mes} ${r.y}</span></div>
    <div class="op-mid"><div class="op-n" style="color:${T.hi}">${pad(num)} / ${pad(total)}</div><h1 class="thin">${title}</h1><p>${desc}</p></div>
    <div class="idx">${items.map(([n, t]) => `<span><em>${n}</em>${esc(t)}</span>`).join('')}</div></section>`;

  const chapters = [];
  if (hasIG) chapters.push('ig');
  if (hasAds || posts.length) chapters.push('pauta');
  if (hasGA || hasGSC) chapters.push('web');
  const goals = lines(opts.goals).map((l) => l.split('|').map((x) => x.trim()));
  const plan = lines(opts.plan).map((l) => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']; });
  if (goals.length || plan.length) chapters.push('metas');
  const chName = { ig: 'Resultados de Instagram', pauta: hasAds ? 'Pauta y contenido' : 'Contenido', web: 'Sitio web y Google', metas: `Metas y ${r.nextMes}` };
  const chTitle = { ig: 'Resultados<br>de Instagram', pauta: hasAds ? 'Pauta<br>y contenido' : 'Contenido<br>del mes', web: 'Sitio web<br>y Google', metas: `Metas<br>y ${r.nextMes}` };

  const pages = [];
  // ---------- Portada ----------
  const scope = [hasIG ? 'Instagram' : null, hasAds ? 'pauta' : null, hasGA || hasGSC ? 'sitio web' : null].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' y $1');
  pages.push(`<section class="pg op cover" style="background:${T.dark}">${photo(0) ? `<div class="bgph" style="background-image:url('${esc(photo(0))}')"></div><div class="tint" style="background:${T.dark}"></div>` : ''}
    <div class="top"><img class="lg inv" src="/logo/${esc(c.slug)}" alt=""><span class="tr">Reporte mensual</span></div>
    <div class="cv"><h1 class="huge thin">${cap(r.mes)}<b style="color:${T.hi}">.</b></h1>
    <p>${cap(scope || 'Resultados')} del 1 al ${r.days} de ${r.mes} de ${r.y}${plan.length ? `, y el plan para ${r.nextMes}` : ''}.</p></div>
    <div class="idx">${chapters.map((k, i) => `<span><em>${pad(i + 1)}</em>${esc(chName[k])}</span>`).join('')}<span class="st">STROVE</span></div></section>`);

  let chN = 0;
  // ---------- 01 · Instagram ----------
  if (hasIG) {
    chN++;
    const sub = [];
    pages.push({ opener: [chN, chTitle.ig, 'Cuánta gente vio la cuenta, cuántos llegaron al perfil y quién nos sigue hoy.', sub, photo(1)] });
    // Resumen en cuatro números
    const cards = [
      reachVal != null ? ['Cuentas alcanzadas', kf(reachVal), dPill(reachVal, reachPrevVal, { long: true, kind: 'hi' })] : null,
      convs != null ? ['Conversaciones', nf(convs), dPill(convs, prev.ad_messages, { long: true })] : ['Interacciones', kf(ig.inter), dPill(ig.inter, ig.interPrev, { long: true })],
      ig.clicks != null ? ['Clics en el enlace', nf(ig.clicks), dPill(ig.clicks, ig.clicksPrev, { long: true })] : ig.profile != null ? ['Visitas al perfil', nf(ig.profile), dPill(ig.profile, ig.profilePrev, { long: true })] : ['Publicaciones', nf(posts.length), ''],
      fNow ? [ig.newF != null ? 'Seguidores nuevos' : 'Seguidores', ig.newF != null ? `${ig.newF >= 0 ? '' : '−'}${nf(Math.abs(ig.newF))}` : nf(fNow.value), pill(`Ya somos ${nf(fNow.value)}`)] : null,
    ].filter(Boolean).slice(0, 4);
    sub.push(['Resumen del mes']);
    pages.push(`<section class="pg">${head('01', 'Resumen del mes', `${cap(r.mes)} en ${['', 'un número', 'dos números', 'tres números', 'cuatro números'][cards.length]}`)}
      <div class="cards c${cards.length}">${cards.map(([l, v, p], i) => `<div class="card ${i ? '' : 'dk'}"><div class="cl">${l}</div><div class="cv2">${v}</div>${p}</div>`).join('')}</div>
      ${opts.note ? `<div class="frase"><span class="scr" style="color:${T.warm}">En una frase</span><span>${esc(lines(opts.note)[0])}</span></div>` : ''}
      ${foot('META BUSINESS SUITE')}</section>`);
    // Crecimiento
    const daily = dReach.length > 3 ? dReach : null;
    if (daily) {
      sub.push(['Crecimiento']);
      const vals = daily.map((d) => d.value); const mx = Math.max(...vals); const pk = daily[vals.indexOf(mx)];
      const rows = [
        ig.views ? ['Visualizaciones', nf(ig.views), dPill(ig.views, ig.viewsPrev)] : null,
        reachVal != null ? ['Cuentas alcanzadas', kf(reachVal), dPill(reachVal, reachPrevVal)] : null,
        ig.profile != null ? ['Visitas al perfil', nf(ig.profile), dPill(ig.profile, ig.profilePrev)] : null,
        ig.clicks != null ? ['Clics en el enlace', nf(ig.clicks), dPill(ig.clicks, ig.clicksPrev)] : null,
        ['Interacciones', nf(ig.inter), dPill(ig.inter, ig.interPrev)],
        convs != null ? ['Conversaciones', nf(convs), dPill(convs, prev.ad_messages)] : null,
        ig.newF != null ? ['Seguidores nuevos', nf(ig.newF), ''] : null,
      ].filter(Boolean).slice(0, 6);
      const big = ig.views ? (ig.views >= 1000 ? `${nf(Math.round(ig.views / 1000))} mil visualizaciones en un mes` : `${nf(ig.views)} visualizaciones en un mes`) : `${kf(reachVal)} de alcance en ${r.mes}`;
      pages.push(`<section class="pg">${head('01', 'Crecimiento de la cuenta', big)}
        <div class="g2"><div class="chartbox" style="background:${T.dark}"><div class="cb-h"><span>Alcance por día</span>${pill(`Pico: ${nf(mx)} · ${+pk.date.slice(8, 10)} ${r.mes.slice(0, 3)}`, 'hi')}</div>${chart(daily, T.hi)}
          <div class="cb-x"><span>1 ${r.mes.slice(0, 3)}</span><span>${+daily[Math.floor(daily.length / 2)].date.slice(8, 10)} ${r.mes.slice(0, 3)}</span><span>${+daily[daily.length - 1].date.slice(8, 10)} ${r.mes.slice(0, 3)}</span></div></div>
        <div class="ledger">${rows.map(([l, v, p]) => `<div class="lr"><span>${l}</span><b>${v}</b>${p}</div>`).join('')}</div></div>
        <div class="ft"><span>VARIACIÓN CONTRA ${r.prevMes.toUpperCase()} · FUENTE: META BUSINESS SUITE</span><span class="pn"></span></div></section>`);
    }
    // Embudo
    const funnel = [
      ig.views ? ['Visualizaciones', 'Veces que se vio el contenido', ig.views] : null,
      reachVal != null ? ['Cuentas alcanzadas', 'Personas distintas', reachVal] : null,
      ig.profile != null ? ['Visitas al perfil', reachVal ? `${nf((ig.profile / reachVal) * 100, 1)}% de los alcanzados` : '', ig.profile] : null,
      ig.clicks != null ? ['Clics en el enlace', ig.profile ? `${nf((ig.clicks / ig.profile) * 100)}% de las visitas` : '', ig.clicks] : null,
      convs ? ['Conversaciones', 'Mensajes directos iniciados', convs] : null,
    ].filter(Boolean);
    if (funnel.length >= 3) {
      sub.push(['Camino al cliente']);
      const cols = [T.dark, mix(T.dark, '#ffffff', 0.18), T.muted, T.warm, T.hi];
      const lmax = Math.log10(funnel[0][2] || 10);
      pages.push(`<section class="pg">${head('01', 'De la pantalla al negocio', 'El camino hacia un cliente')}
        <div class="fun">${funnel.map(([l, s, v], i) => `<div class="fr"><div class="fl"><b>${l}</b><span>${s}</span></div><div class="fb" style="width:${Math.max(22, (Math.log10(Math.max(v, 1)) / lmax) * 100)}%;background:${cols[i]};color:${i >= 2 && i !== 3 ? T.dark : T.cream}">${nf(v)}</div></div>`).join('')}
          <div class="fr"><div class="fl"><b>Ventas y reservas</b><span>Dato del cliente</span></div><div class="fb dash">[__]</div></div></div>
        <div class="ft"><span>${r.mes.toUpperCase()} ${r.y} · ANCHO DE BARRAS ILUSTRATIVO · FUENTE: META BUSINESS SUITE</span><span class="pn"></span></div></section>`);
    }
    // Audiencia
    if (live.demo && fNow) {
      sub.push(['Audiencia']);
      const ages = (live.demo.age || []).sort((a, b) => b.value - a.value); const at = ages.reduce((a, b) => a + b.value, 0) || 1;
      const gs = live.demo.gender || []; const gt = gs.reduce((a, b) => a + b.value, 0) || 1;
      const g = (k) => Math.round(((gs.find((x) => x.label === k)?.value) || 0) / gt * 100);
      const cities = (live.demo.city || []).sort((a, b) => b.value - a.value); const ct = cities.reduce((a, b) => a + b.value, 0) || 1;
      const topC = cities.slice(0, 4); const other = 100 - topC.reduce((a, b) => a + Math.round(b.value / ct * 100), 0);
      const growth = f90 && f90.value && f90.date < r.from ? pctOf(fNow.value, f90.value) : null;
      const cityName = (s) => String(s || '').split(',')[0];
      pages.push(`<section class="pg dark" style="background:${T.dark}">${head('01', 'Quién nos sigue', `${nf(fNow.value)} seguidores${topC[0] ? `, ${Math.round(topC[0].value / ct * 100)}% de ${esc(cityName(topC[0].label))}` : ''}`, true)}
        <div class="aud">${growth != null ? `<div class="gbox"><div class="cl">Desde ${MESES[+f90.date.slice(5, 7) - 1]}</div><div class="gv" style="color:${T.hi}">${growth >= 0 ? '+' : '−'}${Math.abs(growth)}%</div><p>De ${nf(f90.value)} a ${nf(fNow.value)} seguidores.</p></div>` : '<div></div>'}
          <div><div class="cl">Edad</div>${ages.slice(0, 5).map((a, i) => `<div class="ab"><span>${esc(a.label)}</span><i style="width:${(a.value / ages[0].value) * 60}%;background:${i < 2 ? T.hi : T.muted}"></i><b>${Math.round(a.value / at * 100)}%</b></div>`).join('')}
            ${gs.length ? `<div class="gnd">${g('M')}% hombres · ${g('F')}% mujeres</div>` : ''}</div>
          <div><div class="cl">Ciudades</div><div class="cities">${topC.map((x, i) => `<div><span>${esc(cityName(x.label))}</span><b style="${i < 2 ? `color:${T.hi}` : ''}">${Math.round(x.value / ct * 100)}%</b></div>`).join('')}${other > 0 ? `<div class="o"><span>Otras ciudades</span><b>${other}%</b></div>` : ''}</div></div></div>
        ${foot('META BUSINESS SUITE')}</section>`);
    }
  }

  // ---------- 02 · Pauta y contenido ----------
  if (chapters.includes('pauta')) {
    chN++;
    const sub = [];
    pages.push({ opener: [chN, chTitle.pauta, hasAds ? 'Lo que se invirtió en anuncios, cuántas conversaciones trajo y el contenido que más conectó.' : 'El contenido que más conectó y todo lo publicado en el mes.', sub, photo(2)] });
    if (hasAds) {
      sub.push(['La pauta']);
      const nAds = live.ads.length;
      pages.push(`<section class="pg warm" style="background:${T.warm}">
        <div class="pz"><div>${head('02', `La pauta de ${r.mes}`, cpc && cpcPrev && cpc < cpcPrev * 0.75 ? 'Cada conversación costó menos' : cpc ? 'Lo que costó cada conversación' : 'Lo que se invirtió en pauta', true)}
          ${cpc ? `<div class="cl lt">Costo por conversación</div><div class="mega">${money(cpc, 2)}</div>${cpcPrev ? `<div class="was"><s>${money(cpcPrev, 2)} en ${r.prevMes}</s>${dPill(cpc, cpcPrev, { kind: 'hi' })}</div>` : ''}`
            : `<div class="cl lt">Inversión</div><div class="mega">${money(cur.ad_spend)}</div>`}
          <div class="tri"><div><b>${nf(convs)}</b><span>conversaciones</span></div><div><b>${money(cur.ad_spend)}</b><span>${nAds ? `en ${nAds} anuncio${nAds > 1 ? 's' : ''}` : 'de inversión'}</span></div><div><b>${kf(cur.ad_clicks)}</b><span>clics</span></div></div></div>
          ${photo(1) ? `<div class="pzph" style="background-image:url('${esc(photo(1))}')"></div>` : ''}</div>
        <div class="ft"><span>${label} · FUENTE: META ADS</span><span class="pn"></span></div></section>`);
      if (live.ads.length) {
        sub.push(['Anuncios']);
        const ads = live.ads.slice(0, 6).map((a) => ({ ...a, cpm: a.messages ? a.spend / a.messages : null }));
        const best = ads.filter((a) => a.cpm).sort((a, b) => a.cpm - b.cpm)[0];
        const tot = { reach: sum(ads, (a) => a.reach), imp: sum(ads, (a) => a.impressions), msg: sum(ads, (a) => a.messages), spend: sum(ads, (a) => a.spend) };
        const share = best && tot.msg ? Math.round((best.messages / tot.msg) * 10) : null;
        pages.push(`<section class="pg">${head('02', 'Anuncio por anuncio', best ? `«${esc(firstLine(best.name, 34))}» trajo los mensajes más baratos` : 'Así le fue a cada anuncio')}
          <table class="tb"><thead><tr><th>Anuncio</th><th>Alcance</th><th>Impresiones</th><th>Mensajes</th><th>Costo c/u</th><th>Inversión</th></tr></thead><tbody>
          ${ads.map((a) => `<tr class="${a === best ? 'hl' : ''}"><td>${a === best ? `<i style="background:${T.warm}"></i>` : ''}${esc(firstLine(a.name, 46))}</td><td>${nf(a.reach)}</td><td>${nf(a.impressions)}</td><td>${nf(a.messages)}</td><td style="${a === best ? `color:${T.warm};font-weight:700` : ''}">${a.cpm ? money(a.cpm, 2) : '—'}</td><td>${money(a.spend, 2)}</td></tr>`).join('')}
          <tr class="tot" style="background:${T.dark}"><td>Total ${r.mes}</td><td>${nf(tot.reach)}*</td><td>${nf(tot.imp)}</td><td>${nf(tot.msg)}</td><td style="color:${T.hi}">${tot.msg ? money(tot.spend / tot.msg, 2) : '—'}</td><td>${money(tot.spend, 2)}</td></tr></tbody></table>
          ${opts.adsNote || best ? `<div class="next" style="background:${T.dark}">${pill('Por dónde seguir', 'hi')}<span>${esc(opts.adsNote || `${firstLine(best.name, 40)} consiguió mensajes a ${money(best.cpm)}: ahí conviene poner más presupuesto.`)}</span></div>` : ''}
          <div class="ft"><span>*SUMA DE CADA ANUNCIO · FUENTE: META ADS</span><span class="pn"></span></div></section>`);
      }
    }
    if (posts.length >= 3) {
      sub.push(['Podio del feed']);
      const [p1, p2, p3] = byReach;
      const tag = (p, n) => `<div class="pt"><div class="ptk" style="${n === 1 ? `color:${T.warm}` : ''}">${n}° · ${p.type === 'CAROUSEL_ALBUM' ? 'Carrusel' : p.type === 'REEL' || p.type === 'VIDEO' ? 'Reel' : 'Post'} · ${+p.local_date.slice(8, 10)} ${r.mes.slice(0, 3)}</div><b>${esc(firstLine(p.caption, 48))}</b><span>${nf(p.reach ?? p.views)} cuentas · ${nf(inter(p))} interacciones</span></div>`;
      pages.push(`<section class="pg">${head('02', 'Contenido del mes', `El podio del feed en ${r.mes}`)}
        <div class="podium"><div class="pc2">${tag(p2, 2)}<div class="blk" style="height:44%;background:${mix(T.dark, '#ffffff', 0.18)};color:${T.cream}">2</div></div>
          <div class="pc2">${tag(p1, 1)}<div class="blk" style="height:56%;background:${T.dark};color:${T.hi}">1</div></div>
          <div class="pc2">${tag(p3, 3)}<div class="blk" style="height:34%;background:${T.muted};color:${T.dark}">3</div></div></div>
        <div class="ft"><span>RANKING POR ALCANCE · FUENTE: META BUSINESS SUITE</span><span class="pn"></span></div></section>`);
      sub.push(['Publicaciones']);
      const list = posts.slice(0, 12);
      pages.push(`<section class="pg">${head('02', 'Todas las publicaciones', `${posts.length} publicaciones en el feed`)}
        <table class="tb sm"><thead><tr><th>Publicación</th><th>Fecha</th><th>Alcance</th><th>Interac.</th><th>Guardados</th></tr></thead><tbody>
        ${list.map((p) => `<tr class="${p === p1 ? 'hl' : ''}"><td>${p === p1 ? `<i style="background:${T.warm}"></i>` : ''}${esc(firstLine(p.caption, 58))}</td><td>${+p.local_date.slice(8, 10)} ${r.mes.slice(0, 3)}</td><td>${nf(p.reach ?? p.views)}</td><td>${nf(inter(p))}</td><td>${nf(p.saves)}</td></tr>`).join('')}</tbody></table>
        ${foot('META BUSINESS SUITE')}</section>`);
    }
  }

  // ---------- 03 · Sitio web y Google ----------
  if (chapters.includes('web')) {
    chN++;
    const sub = [['El sitio en números']];
    pages.push({ opener: [chN, chTitle.web, 'Cuánta gente llegó al sitio, desde dónde y qué buscan en Google.', sub, photo(3)] });
    const cards = [
      hasGA ? ['Visitas al sitio', kf(cur.sessions), dPill(cur.sessions, prev.sessions, { long: true, kind: 'hi' })] : null,
      hasGA && c.leadEvent ? ['Contactos', nf(cur.leads || 0), dPill(cur.leads, prev.leads, { long: true })] : hasGA ? ['Personas', kf(cur.users), dPill(cur.users, prev.users, { long: true })] : null,
      hasGSC ? ['Clics desde Google', nf(cur.clicks), dPill(cur.clicks, prev.clicks, { long: true })] : null,
      hasGSC ? ['Apariciones en Google', kf(cur.impressions), dPill(cur.impressions, prev.impressions, { long: true })] : null,
    ].filter(Boolean);
    pages.push(`<section class="pg">${head(pad(chN), 'El sitio en números', `${cap(r.mes)} en el sitio web`)}
      <div class="cards c${cards.length}">${cards.map(([l, v, p], i) => `<div class="card ${i ? '' : 'dk'}"><div class="cl">${l}</div><div class="cv2">${v}</div>${p}</div>`).join('')}</div>
      ${dSess.length > 3 ? `<div class="mini-chart">${chart(dSess, T.dark, 70, true)}<span>Visitas por día</span></div>` : ''}
      ${foot('GOOGLE ANALYTICS Y SEARCH CONSOLE')}</section>`);
    if (queries.length || channels.length) {
      sub.push(['Búsquedas y canales']);
      const tc = channels.reduce((a, b) => a + b.value, 0) || 1;
      const CH = { 'Organic Search': 'Google orgánico', 'Direct': 'Directo', 'Organic Social': 'Redes sociales', 'Paid Social': 'Pauta en redes', 'Referral': 'Otros sitios', 'Paid Search': 'Google Ads', 'Cross-network': 'Campañas mixtas', 'AI Assistant': 'Asistentes de IA', 'Unassigned': 'Sin clasificar' };
      pages.push(`<section class="pg">${head(pad(chN), 'Cómo nos encuentran', queries[0] ? `«${esc(queries[0].label)}» es lo que más buscan` : 'De dónde llega la gente')}
        <div class="g2b">${channels.length ? `<div><div class="cl">De dónde llegan · últimos 28 días</div>${channels.map((b, i) => `<div class="ab lt"><span>${esc(CH[b.label] || b.label)}</span><i style="width:${(b.value / channels[0].value) * 58}%;background:${i ? T.muted : T.dark}"></i><b>${Math.round(b.value / tc * 100)}%</b></div>`).join('')}</div>` : '<div></div>'}
          ${queries.length ? `<div><div class="cl">Lo que buscan en Google · últimos 28 días</div><div class="cities lt">${queries.map((q) => `<div><span>${esc(q.label)}</span><b>${nf(q.value)} clics</b></div>`).join('')}</div></div>` : ''}</div>
        ${foot('GOOGLE ANALYTICS Y SEARCH CONSOLE')}</section>`);
    }
  }

  // ---------- 04 · Metas y siguiente mes ----------
  if (chapters.includes('metas')) {
    chN++;
    const sub = [];
    pages.push({ opener: [chN, chTitle.metas, `Cómo nos fue contra las metas y qué ajustamos para ${r.nextMes}.`, sub, photo(4)] });
    if (goals.length) {
      sub.push([`El marcador de ${r.mes}`]);
      const st = (s) => { const t = (s || '').toLowerCase(); return t.includes('super') || t.includes('cumpl') || t.includes('logr') ? 'hi' : t.includes('camino') || t.includes('cerca') ? 'mu' : t.includes('dato') || !t ? 'ol' : 'hi'; };
      pages.push(`<section class="pg black">${head(pad(chN), 'Metas del mes', `El marcador de ${r.mes}`, true)}
        <div class="goals"><div class="gh"><span>Meta</span><span>Resultado</span><span>Estado</span></div>${goals.slice(0, 5).map(([m, v, s]) => `<div class="gr"><span>${esc(m)}</span><b style="${st(s) === 'hi' ? `color:${T.hi}` : ''}">${esc(v || '[__]')}</b><span>${s ? `<span class="pill ${st(s)}" style="${st(s) === 'hi' ? `background:${T.hi}` : ''}">${esc(s)}</span>` : ''}</span></div>`).join('')}</div>
        ${foot('')}</section>`);
    }
    if (plan.length) {
      sub.push([`Plan para ${r.nextMes}`]);
      const sty = [[T.dark, T.cream, T.hi, T.dark], [T.card, T.dark, T.dark, T.hi], [T.card, T.dark, T.dark, T.hi], [T.warm, T.cream, T.cream, T.warm]];
      pages.push(`<section class="pg">${head(pad(chN), `Plan para ${r.nextMes}`, `${['', 'Un ajuste', 'Dos ajustes', 'Tres ajustes', 'Cuatro ajustes'][Math.min(plan.length, 4)]} para ${r.nextMes}`)}
        <div class="plan">${plan.slice(0, 4).map(([t, d], i) => { const [bg, fg, cbg, cfg] = sty[i]; return `<div class="pi" style="background:${bg};color:${fg}"><span class="pn2" style="background:${cbg};color:${cfg}">${i + 1}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></div>`; }).join('')}</div>
        ${foot('')}</section>`);
    }
  }

  // ---------- Cierre ----------
  pages.push(`<section class="pg op" style="background:${T.dark}">${photo(5) ? `<div class="bgph" style="background-image:url('${esc(photo(5))}')"></div><div class="tint" style="background:${T.dark}"></div>` : ''}
    <div class="top"><img class="lg inv" src="/logo/${esc(c.slug)}" alt=""><span class="tr">Reporte ${r.mes} ${r.y}</span></div>
    <div class="op-mid"><h1 class="thin">${esc(opts.closing || 'Gracias')}<b style="color:${T.hi}">.</b></h1><p>Abrimos espacio para preguntas y siguientes pasos.</p></div>
    <div class="idx"><span>${esc(c.name)}</span>${c.igUsername ? `<span>@${esc(c.igUsername)}</span>` : c.url ? `<span>${esc(c.url.replace(/^https?:\/\//, ''))}</span>` : ''}<span class="st">STROVE</span></div></section>`);

  // Aperturas de capítulo (necesitan saber sus subpáginas) y numeración
  const total = chapters.length; const html = [];
  pages.forEach((p, i) => {
    if (typeof p === 'string') { html.push(p.replace('<span class="pn"></span>', `<span class="pn">${pad(i + 1)} / ${pad(pages.length)}</span>`)); return; }
    const [num, title, desc, sub, img] = p.opener;
    html.push(opener(num, total, title, desc, sub.map((x, k) => [pad(i + 2 + k), x[0]]), img));
  });

  const fileTitle = `${c.name.replace(/[^\p{L}\p{N}]+/gu, '_')}_Reporte_${cap(r.mes)}_${r.y}`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${esc(fileTitle)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;500;600;700&family=Yellowtail&display=swap" rel="stylesheet">
<style>
@page{size:1440px 810px;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#8d8a83;font-family:Outfit,system-ui,sans-serif;color:${T.dark}}
.pg{width:1440px;height:810px;margin:24px auto;background:${T.cream};position:relative;overflow:hidden;padding:96px 96px 0;page-break-after:always;break-after:page;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.pg.dark{color:${T.cream}}.pg.warm{color:${T.cream}}.pg.black{background:#1B1C1E;color:${T.cream}}
/* aperturas */
.op{color:${T.cream};padding:0}
.bgph{position:absolute;inset:0;background:center/cover;filter:grayscale(1) contrast(1.05)}
.tint{position:absolute;inset:0;opacity:.72;mix-blend-mode:multiply}
.op:after{content:'';position:absolute;inset:0;z-index:1;background:linear-gradient(90deg,rgba(0,0,0,.35),rgba(0,0,0,.05) 70%),linear-gradient(180deg,rgba(0,0,0,0) 60%,rgba(0,0,0,.35))}
.op>*{position:relative;z-index:2}
.op>.bgph,.op>.tint{position:absolute;z-index:0}.op>.tint{z-index:1}
.top{position:absolute;top:48px;left:96px;right:96px;display:flex;justify-content:space-between;align-items:center}
.lg{height:46px;max-width:170px;object-fit:contain;object-position:left}
.inv{filter:brightness(0) invert(.94)}
.tr{font-size:17px;letter-spacing:.24em;text-transform:uppercase;opacity:.85}
.op-mid{position:absolute;left:96px;top:190px;max-width:760px}
.op-n{font-size:18px;letter-spacing:.18em;margin-bottom:26px}
h1.thin{font-weight:200;font-size:118px;line-height:.98;letter-spacing:-.02em}
.op-mid p,.cv p{font-size:23px;line-height:1.55;font-weight:300;margin-top:20px;max-width:620px;opacity:.92}
.cv{position:absolute;left:96px;top:215px}
h1.huge{font-size:190px;line-height:1}
.idx{position:absolute;left:96px;right:96px;bottom:150px;border-top:1px solid rgba(237,230,214,.25);padding-top:26px;display:flex;gap:56px;font-size:21px;font-weight:300}
.idx em{font-style:normal;opacity:.6;margin-right:12px;font-size:17px}
.idx .st{margin-left:auto;letter-spacing:.14em;opacity:.7}
/* encabezado de página */
.hd{display:flex;justify-content:space-between;align-items:center;margin-top:-14px}
.kick{font-size:17px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:${T.warm};display:flex;align-items:center;gap:14px}
.kick i{width:12px;height:12px;border-radius:50%;background:currentColor}
.kick.hi{color:${T.hi}}
.mini{height:52px;max-width:120px;object-fit:contain}
h2{font-size:62px;font-weight:600;letter-spacing:-.035em;line-height:1.05;margin:40px 0 34px}
.ft{position:absolute;left:96px;right:96px;bottom:44px;display:flex;justify-content:space-between;font-size:16px;letter-spacing:.1em;opacity:.75}
/* tarjetas */
.cards{display:grid;gap:24px}.c4{grid-template-columns:repeat(4,1fr)}.c3{grid-template-columns:repeat(3,1fr)}.c2{grid-template-columns:repeat(2,1fr)}
.card{background:${T.card};border-radius:22px;padding:34px 30px 30px}
.card.dk{background:${T.dark};color:${T.cream}}
.cl{font-size:16px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;opacity:.8;margin-bottom:14px}
.cl.lt{opacity:.95}
.cv2{font-size:86px;font-weight:600;letter-spacing:-.04em;line-height:1;margin-bottom:22px}
.pill{display:inline-block;font-size:17px;font-weight:600;padding:6px 15px;border-radius:999px;white-space:nowrap}
.pill.dk{background:${T.dark};color:${T.hi}}.pill.hi{background:${T.hi};color:${T.dark}}.pill.mu{background:${T.muted};color:${T.dark}}.pill.ol{border:2px solid ${T.cream};color:${T.cream};padding:4px 13px}
.frase{border-top:2px solid ${T.dark};margin-top:40px;padding-top:26px;display:flex;align-items:baseline;gap:22px;font-size:25px}
.scr{font-family:Yellowtail,cursive;font-size:42px;white-space:nowrap}
/* crecimiento */
.g2{display:grid;grid-template-columns:1.25fr .75fr;gap:58px}
.chartbox{border-radius:22px;padding:28px 30px 20px;color:${T.cream}}
.cb-h{display:flex;justify-content:space-between;align-items:center;font-size:16px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}
.cb-x{display:flex;justify-content:space-between;font-size:17px;opacity:.8;margin-top:8px}
svg.ch{width:100%;height:290px;display:block;margin-top:10px}
.ledger{border-top:2px solid ${T.dark}}
.lr{display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:16px 0;border-bottom:1px solid rgba(0,0,0,.12);font-size:22px}
.lr b{font-weight:600}
.pg.dark .ledger{border-color:${T.cream}}
/* embudo */
.fun{display:flex;flex-direction:column;gap:20px;margin-top:-6px}
.fr{display:grid;grid-template-columns:330px 1fr;align-items:center}
.fl b{display:block;font-size:22px;font-weight:600}.fl span{font-size:18px;opacity:.75}
.fb{height:58px;border-radius:12px;display:flex;align-items:center;padding:0 22px;font-size:26px;font-weight:600}
.fb.dash{width:22%;border:3px dashed ${T.dark};background:none}
/* audiencia */
.aud{display:grid;grid-template-columns:330px 1fr 330px;gap:58px}
.gbox{background:rgba(0,0,0,.22);border-radius:22px;padding:34px 30px}
.gv{font-size:96px;font-weight:600;letter-spacing:-.04em;line-height:1.05}
.gbox p{font-size:21px;line-height:1.45;margin-top:12px}
.ab{display:grid;grid-template-columns:90px 1fr;align-items:center;gap:0;font-size:21px;margin:12px 0;position:relative}
.ab i{height:26px;border-radius:13px;display:block}.ab b{position:absolute;left:calc(90px + var(--w,0%));}
.ab{grid-template-columns:90px auto 1fr}.ab b{position:static;margin-left:14px;font-size:19px}
.ab.lt{grid-template-columns:220px auto 1fr}
.gnd{font-size:18px;opacity:.75;margin-top:16px}
.cities div{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid rgba(237,230,214,.2);font-size:22px}
.cities.lt div{border-color:rgba(0,0,0,.12)}
.cities .o span{opacity:.7}
.g2b{display:grid;grid-template-columns:1fr 1fr;gap:70px}
/* pauta */
.pz{display:grid;grid-template-columns:1fr 520px;gap:60px;height:100%}
.pg.warm .pz{margin-top:-30px}
.mega{font-size:170px;font-weight:600;letter-spacing:-.05em;line-height:1}
.was{display:flex;align-items:center;gap:20px;font-size:24px;margin-top:6px}.was s{opacity:.85}
.tri{display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:70px}
.tri div{border-top:1px solid rgba(237,230,214,.6);padding-top:20px}.tri b{display:block;font-size:46px;font-weight:600;letter-spacing:-.03em}.tri span{font-size:19px}
.pzph{border-radius:22px;background:center/cover;height:620px;margin-top:30px}
.tb{width:100%;border-collapse:collapse;font-size:21px}
.tb th{font-size:16px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;text-align:right;padding:0 20px 14px;opacity:.8;border-bottom:2px solid ${T.dark}}
.tb th:first-child,.tb td:first-child{text-align:left}
.tb td{padding:18px 20px;text-align:right;border-bottom:1px solid rgba(0,0,0,.1);font-weight:400}
.tb td:first-child{font-weight:600}
.tb td i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:10px;vertical-align:middle}
.tb tr.hl{background:${T.card}}
.tb tr.tot td{color:${T.cream};font-weight:600;border:0}
.tb.sm td{padding:12px 20px;font-size:20px}
.tb.sm td:first-child{font-weight:400}.tb.sm tr.hl td:first-child{font-weight:600}
.next{margin-top:30px;border-radius:20px;padding:22px 34px;color:${T.cream};display:flex;align-items:center;gap:30px;font-size:23px}
/* podio */
.podium{display:grid;grid-template-columns:repeat(3,1fr);gap:34px;height:470px;align-items:end;border-bottom:7px solid ${T.dark};margin:0 40px}
.pc2{display:flex;flex-direction:column;justify-content:flex-end;height:100%}
.pt{padding:0 8px 16px}.ptk{font-size:18px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;opacity:.85}
.pt b{display:block;font-size:24px;font-weight:600;line-height:1.25;margin:6px 0}.pt span{font-size:18px;opacity:.75}
.blk{border-radius:22px 22px 0 0;display:flex;align-items:center;justify-content:center;font-size:120px;font-weight:600}
/* sitio */
.mini-chart{margin-top:38px}.mini-chart svg{height:120px}.mini-chart span{font-size:16px;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
/* metas */
.goals .gh,.goals .gr{display:grid;grid-template-columns:1.5fr 1fr .9fr;align-items:center}
.gh{font-size:16px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;opacity:.75;padding:0 38px 12px}
.gr{background:#26272A;border-radius:18px;padding:22px 38px;margin-bottom:14px;font-size:24px}
.gr b{font-size:52px;font-weight:600;letter-spacing:-.03em;line-height:1}
.plan{display:grid;grid-template-columns:1fr 1fr;gap:26px}
.pi{border-radius:22px;padding:34px 38px;display:flex;gap:28px;align-items:flex-start;min-height:200px}
.pn2{flex:0 0 66px;height:66px;border-radius:50%;display:grid;place-items:center;font-size:26px;font-weight:600}
.pi b{font-size:28px;font-weight:600;display:block;margin-bottom:8px}.pi p{font-size:21px;line-height:1.5;opacity:.85}
.bar-top{position:sticky;top:0;z-index:5;background:#141414;color:#fff;display:flex;gap:14px;align-items:center;justify-content:center;padding:12px;font-size:15px}
.bar-top button{background:#fff;color:#141414;border:0;border-radius:999px;padding:9px 18px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}
.bar-top span{opacity:.75}
@media print{body{background:none}.pg{margin:0;box-shadow:none}.bar-top{display:none}}
@media screen and (max-width:1500px){.pg{zoom:.9}}
</style></head><body>
<div class="bar-top"><button onclick="window.print()">Descargar PDF</button><span>En la ventana que se abre, elige <b>“Guardar como PDF”</b>.</span></div>
${html.join('\n')}
<script>
const imgs=[...document.querySelectorAll('[style*="background-image"]')].map(e=>(e.style.backgroundImage.match(/url\\(["']?(.*?)["']?\\)/)||[])[1]).filter(Boolean);
Promise.all([document.fonts.ready,...imgs.map(u=>new Promise(r=>{const i=new Image();i.onload=i.onerror=r;i.src=u;}))]).then(()=>{if(new URLSearchParams(location.search).get('print')==='1')setTimeout(()=>window.print(),300);});
</script></body></html>`;
}

// Gráfica de área (SVG)
function chart(rows, color, h = 290, light = false) {
  const W = 800; const vals = rows.map((d) => d.value || 0); const max = Math.max(1, ...vals);
  const x = (i) => (i * W) / Math.max(1, vals.length - 1); const y = (v) => h - 8 - (v / max) * (h - 30);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const grid = light ? '' : [0.25, 0.5, 0.75].map((g) => `<line x1="0" x2="${W}" y1="${(h * g).toFixed(0)}" y2="${(h * g).toFixed(0)}" stroke="rgba(237,230,214,.12)"/>`).join('');
  return `<svg class="ch" viewBox="0 0 ${W} ${h}" preserveAspectRatio="none">${grid}<path d="${d}L${W},${h}L0,${h}Z" fill="${color}" opacity="${light ? 0.1 : 0.22}"/><path d="${d}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}
// Mezcla dos colores hex
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

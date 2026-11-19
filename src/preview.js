// Vista previa de los posts del mes (para presentarle al cliente lo que viene).
// Réplica del formato de parrillas de Strove: portada, "así se verá el feed" y una página por post
// con el mockup de Instagram, el caption completo y las láminas del carrusel.

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad = (n) => String(n).padStart(2, '0');
const nf = (v) => (v == null ? '—' : Number(v).toLocaleString('es-MX'));

function splitTags(caption) {
  const lines = String(caption || '').split('\n'); let i = lines.length;
  while (i > 0 && (/^\s*(#[^\s#]+\s*)+$/.test(lines[i - 1]) || !lines[i - 1].trim())) i--;
  return { body: lines.slice(0, i).join('\n').trim(), tags: (lines.slice(i).join(' ').match(/#[^\s#]+/g) || []).join(' ') };
}
const firstLine = (s) => (String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '');

const ICONS = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 6.9 4.5c2.1 0 3.6 1.2 5.1 3 1.5-1.8 3-3 5.1-3 3.5 0 5.5 3.5 4.2 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M20.7 16.3A9 9 0 1 0 17 20l4 1-0.3-4.7z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M22 3 9.2 10.8M22 3l-7 18-3-8.4L3 9.5z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V3h14z"/></svg>',
};

export async function renderPreview(env, c, mes, opts = {}) {
  const [y, m] = mes.split('-').map(Number);
  const from = `${mes}-01`, to = `${mes}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  const { results: items } = await env.DB.prepare(
    `SELECT id, date, time, format, title, series, copy, status, post_id, image IS NOT NULL AS has_image, updated_at,
       (SELECT COUNT(*) FROM plan_slides s WHERE s.plan_id = content_plan.id) AS slides
     FROM content_plan WHERE client = ? AND date BETWEEN ? AND ? AND network IN ('instagram', 'ambas') ORDER BY date, time`).bind(c.slug, from, to).all();
  const prof = JSON.parse((await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('igprofile:' + c.slug).first())?.value || '{}');
  const { results: recent } = await env.DB.prepare('SELECT id, thumb FROM posts WHERE client = ? AND thumb IS NOT NULL ORDER BY published_at DESC LIMIT 12').bind(c.slug).all();

  const theme = { bg: c.report?.bg || '#0A0A0A', accent: c.report?.accent || c.color || '#534AB7' };
  const strong = c.report?.bg || c.color || '#1b1b1b';
  const user = prof.username || c.igUsername || c.slug;
  const intro = opts.intro || `Vista previa de los posts de Instagram de @${user}.`;
  const imgUrl = (it) => `/api/plan/${it.id}/img?v=${encodeURIComponent(it.updated_at)}`;
  const avatar = (size) => `<span class="av" style="width:${size}px;height:${size}px;background:${theme.accent}"><img src="/logo/${esc(c.slug)}" alt=""></span>`;
  const pages = [];

  // 1 · Portada
  pages.push(`<section class="page cover" style="background:${theme.bg}">
    <img class="clogo" src="/logo/${esc(c.slug)}" alt="${esc(c.name)}">
    <div class="cv-mid"><h1>${cap(MESES[m - 1])} <i style="color:${theme.accent}">${y}</i></h1>
    <p>${esc(intro).replace(/\n/g, '<br>')}</p></div>
  </section>`);

  // 2 · Así se verá el feed (lo nuevo primero, completado con lo ya publicado)
  const planned = items.filter((i) => i.has_image).slice().reverse().map((i) => ({ src: imgUrl(i) }));
  const usedPosts = new Set(items.map((i) => i.post_id).filter(Boolean));
  const grid = [...planned, ...recent.filter((p) => !usedPosts.has(p.id)).map((p) => ({ src: p.thumb, old: true }))].slice(0, 9);
  const bioName = prof.name || c.name;
  pages.push(`<section class="page">
    <h2 class="ctr">Así se verá el feed</h2>
    <div class="profile">
      <div class="pf-h">${avatar(82)}<div><div class="pf-u">${esc(user)}</div>
        <div class="pf-s"><div><b>${nf(prof.media != null ? prof.media + items.filter((i) => !i.post_id).length : null)}</b><span>publicaciones</span></div><div><b>${nf(prof.followers)}</b><span>seguidores</span></div><div><b>${nf(prof.follows)}</b><span>seguidos</span></div></div></div></div>
      <div class="pf-bio"><b>${esc(bioName)}</b>${prof.biography ? `<br>${esc(prof.biography).replace(/\n/g, '<br>')}` : ''}</div>
      <div class="pf-grid">${grid.map((g) => `<div class="gc ${g.old ? 'old' : ''}" style="background-image:url('${esc(g.src)}')"></div>`).join('')}</div>
    </div>
  </section>`);

  // 3 · Una página por post
  for (const it of items) {
    const d = new Date(it.date + 'T12:00:00Z');
    const head = `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}${it.series ? ' · ' + it.series : ''}`.toUpperCase();
    const { body, tags } = splitTags(it.copy);
    const n = it.slides || 1;
    const fmtName = it.format === 'reel' ? 'Reel' : it.format === 'historia' ? 'Historia' : 'Carrusel completo';
    pages.push(`<section class="page post">
      <div class="ph-d">${esc(head)}</div>
      <h2>${esc(it.title || firstLine(it.copy).slice(0, 80))}</h2>
      <div class="pp">
        <div class="ig">
          <div class="ig-h">${avatar(28)}<b>${esc(user)}</b><span class="dots3">···</span></div>
          <div class="ig-img" style="${it.has_image ? `background-image:url('${imgUrl(it)}')` : ''}">${n > 1 ? `<span class="cnt">1/${n}</span>` : ''}</div>
          <div class="ig-a"><span class="ic">${ICONS.heart}</span><span class="ic">${ICONS.comment}</span><span class="ic">${ICONS.share}</span>
            ${n > 1 ? `<span class="pg">${Array.from({ length: Math.min(n, 10) }, (_, k) => `<i class="${k ? '' : 'on'}"></i>`).join('')}</span>` : '<span class="pg"></span>'}<span class="ic r">${ICONS.save}</span></div>
          <div class="ig-c"><b>${esc(user)}</b> ${esc(firstLine(body))} <span class="mas">más</span></div>
        </div>
        <div class="capcol">
          <div class="lbl">Caption (fuera de la foto)</div>
          <div class="cap">${esc(body)}</div>
          ${tags ? `<div class="tags" style="color:${strong}">${esc(tags)}</div>` : ''}
        </div>
      </div>
      ${it.slides > 1 ? `<div class="strip"><div class="lbl">${fmtName} · ${it.slides} láminas</div>
        <div class="sl">${Array.from({ length: it.slides }, (_, k) => `<figure><div style="background-image:url('/api/plan/${it.id}/slides/${k + 1}')"></div><figcaption>${pad(k + 1)}</figcaption></figure>`).join('')}</div></div>` : ''}
    </section>`);
  }
  if (!items.length) pages.push(`<section class="page"><h2>Todavía no hay posts en ${MESES[m - 1]}.</h2><p style="margin-top:12px">Agrégalos en el calendario del Hub o sube la parrilla.</p></section>`);

  const title = `${c.name.replace(/[^\p{L}\p{N}]+/gu, '_')}_${cap(MESES[m - 1])}_${y}_Vista_previa`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@page{size:letter;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{background:#cfcbc2;font-family:Inter,system-ui,sans-serif;color:#141414}
.page{width:8.5in;height:11in;margin:24px auto;background:#F9F7F2;position:relative;overflow:hidden;padding:.58in .58in;page-break-after:always;break-after:page;box-shadow:0 8px 34px rgba(0,0,0,.2)}
h1,h2{font-family:'Cormorant Garamond',Georgia,serif;font-weight:400}
.cover{color:#F1ECE2;padding:.85in .72in}
.clogo{height:62px;max-width:190px;object-fit:contain;object-position:left;filter:brightness(0) invert(.94)}
.cv-mid{position:absolute;left:.72in;right:.72in;top:46%}
.cover h1{font-size:44pt;line-height:1.05}
.cover h1 i{font-style:italic}
.cover p{margin-top:16px;max-width:4.1in;font-size:9.3pt;line-height:1.65;opacity:.9}
.ctr{text-align:center;font-size:27pt;margin-top:.1in}
.profile{width:5.6in;margin:.32in auto 0;background:#fff;border:1px solid #e6e1d6;border-radius:14px;padding:.22in .2in .2in}
.pf-h{display:flex;gap:18px;align-items:center}
.av{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;flex-shrink:0}
.av img{width:66%;height:66%;object-fit:contain;filter:brightness(0);opacity:.82}
.pf-u{font-size:11pt;font-weight:600;margin-bottom:6px}
.pf-s{display:flex;gap:24px}.pf-s div{display:flex;flex-direction:column;font-size:8.3pt;color:#444}.pf-s b{font-size:11pt;color:#141414}
.pf-bio{font-size:8.6pt;line-height:1.55;margin:12px 0 12px}
.pf-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
.gc{aspect-ratio:4/5;background:#e9e5dc center/cover}
.gc.old{filter:saturate(.85)}
.post .ph-d{font-size:7.6pt;font-weight:600;letter-spacing:.2em;color:#5d5a54}
.post h2{font-size:23pt;line-height:1.15;margin-top:6px}
.pp{display:grid;grid-template-columns:3.55in 1fr;gap:.4in;margin-top:.24in}
.ig{background:#fff;border:1px solid #e3ded3;border-radius:10px;overflow:hidden}
.ig-h{display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:8.6pt}
.dots3{margin-left:auto;color:#555;letter-spacing:1px}
.ig-img{aspect-ratio:4/5;background:#e9e5dc center/cover;position:relative}
.cnt{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.55);color:#fff;font-size:7.3pt;font-weight:600;padding:3px 7px;border-radius:999px}
.ig-a{display:flex;align-items:center;gap:12px;padding:9px 10px 4px}
.ic svg{width:17px;height:17px;fill:none;stroke:#141414;stroke-width:1.8;stroke-linejoin:round;display:block}
.ic.r{margin-left:auto}
.pg{flex:1;display:flex;justify-content:center;gap:3px;margin-right:-25px}.pg i{width:5px;height:5px;border-radius:50%;background:#cfcfcf}.pg i.on{background:#3897f0}
.ig-c{font-size:8.4pt;line-height:1.45;padding:4px 10px 11px}
.mas{color:#8e8e8e}
.lbl{font-size:7.2pt;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:#6a675f;margin-bottom:6px}
.cap{white-space:pre-wrap;font-size:8.2pt;line-height:1.62}
.tags{font-size:7.9pt;font-weight:700;line-height:1.6;margin-top:10px}
.strip{position:absolute;left:.58in;right:.58in;bottom:.5in}
.sl{display:grid;grid-template-columns:repeat(8,1fr);gap:6px}
.sl figure div{aspect-ratio:4/5;background:#e9e5dc center/cover;border:1px solid #e3ded3}
.sl figcaption{font-size:6.8pt;color:#6a675f;margin-top:4px}
.bar-top{position:sticky;top:0;z-index:5;background:#141414;color:#fff;display:flex;gap:14px;align-items:center;justify-content:center;padding:12px;font-size:10pt}
.bar-top button{background:#fff;color:#141414;border:0;border-radius:999px;padding:9px 18px;font-weight:600;font-size:10pt;cursor:pointer}
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

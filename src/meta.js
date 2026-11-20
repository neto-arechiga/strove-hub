// Meta (Instagram + pauta) con el token de un "usuario del sistema" del Business Manager de Strove.
// Solo lectura. Lo programado en Business Suite NO se puede leer por API: el calendario vive en el Hub.

const ver = (env) => env.META_API_VERSION || 'v23.0';

async function graph(env, path, params = {}) {
  if (!env.META_TOKEN) throw new Error('Falta el secreto META_TOKEN');
  const url = new URL(`https://graph.facebook.com/${ver(env)}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', String(env.META_TOKEN).trim());
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Meta: ${data.error?.message || res.status}`);
  return data;
}

// Fecha local de Guadalajara (para empatar con el calendario)
export const localDate = (iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const todayLocal = () => localDate(new Date().toISOString());

export async function fetchInstagram(env, client, days) {
  const rows = [];
  if (!client.igUserId) throw new Error('Sin cuenta de Instagram');
  // Seguidores: Meta solo da el número de hoy; el historial lo vamos guardando nosotros cada noche
  const profile = await graph(env, client.igUserId, { fields: 'followers_count,follows_count,media_count,username,name,biography' });
  rows.push({ date: todayLocal(), metric: 'followers', value: profile.followers_count || 0 });

  // Alcance diario de la cuenta (máx. 30 días por consulta)
  const until = Math.floor(Date.now() / 1000);
  const since = until - Math.min(days, 30) * 86400;
  try {
    const ins = await graph(env, `${client.igUserId}/insights`, { metric: 'reach', period: 'day', since, until });
    for (const v of ins.data?.[0]?.values || []) rows.push({ date: localDate(v.end_time), metric: 'reach', value: v.value || 0 });
  } catch { /* algunas cuentas nuevas no tienen insights todavía */ }

  // Últimos posts con sus números
  const media = await graph(env, `${client.igUserId}/media`, {
    fields: 'id,caption,media_type,media_product_type,permalink,media_url,thumbnail_url,timestamp,like_count,comments_count',
    limit: 30,
  });
  const list = media.data || [];
  // Métricas de todos los posts en UNA sola llamada (batch de Graph): cuida el límite de subrequests del Worker
  const insById = {};
  if (list.length) {
    try {
      const body = new URLSearchParams({
        access_token: String(env.META_TOKEN).trim(),
        batch: JSON.stringify(list.map((m) => ({ method: 'GET', relative_url: `${m.id}/insights?metric=views,reach,saved,shares` }))),
      });
      const res = await fetch(`https://graph.facebook.com/${ver(env)}/`, { method: 'POST', body });
      const out = await res.json();
      (Array.isArray(out) ? out : []).forEach((r, i) => {
        if (!r || r.code !== 200) return; // posts viejos o de otro tipo pueden no traer insights
        try { insById[list[i].id] = JSON.parse(r.body).data || []; } catch { /* ignora */ }
      });
    } catch { /* sin métricas por post esta vez */ }
  }
  const posts = [];
  for (const m of list) {
    const p = {
      id: m.id, type: m.media_product_type === 'REELS' ? 'REEL' : m.media_type, caption: (m.caption || '').slice(0, 600),
      permalink: m.permalink, thumb: m.thumbnail_url || m.media_url || null, published_at: m.timestamp,
      local_date: localDate(m.timestamp), likes: m.like_count ?? null, comments: m.comments_count ?? null,
      views: null, reach: null, saves: null, shares: null,
    };
    for (const x of insById[m.id] || []) {
      const v = x.values?.[0]?.value ?? x.total_value?.value ?? null;
      if (x.name === 'views') p.views = v;
      if (x.name === 'reach') p.reach = v;
      if (x.name === 'saved') p.saves = v;
      if (x.name === 'shares') p.shares = v;
    }
    posts.push(p);
  }
  return { rows, posts, username: profile.username, profile: { username: profile.username, name: profile.name || '', biography: profile.biography || '', followers: profile.followers_count ?? null, follows: profile.follows_count ?? null, media: profile.media_count ?? null } };
}

export async function resolveAdAccount(env, client) {
  if (client.adAccountId) return client.adAccountId;
  const data = await graph(env, 'me/adaccounts', { fields: 'name,account_id', limit: 100 });
  const want = String(client.adAccountName || '').toLowerCase();
  const acc = (data.data || []).find((a) => a.name?.toLowerCase() === want) || (data.data || []).find((a) => a.name?.toLowerCase().includes(want));
  if (!acc) throw new Error(`No encuentro la cuenta publicitaria "${client.adAccountName}"`);
  return acc.account_id;
}

export async function fetchAds(env, client, days) {
  const adId = await resolveAdAccount(env, client);
  const until = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const data = await graph(env, `act_${adId}/insights`, {
    fields: 'spend,reach,clicks,actions',
    time_increment: 1,
    time_range: JSON.stringify({ since, until }),
    limit: 500,
  });
  const rows = [];
  for (const d of data.data || []) {
    const date = d.date_start;
    rows.push({ date, metric: 'ad_spend', value: +d.spend || 0 });
    rows.push({ date, metric: 'ad_clicks', value: +d.clicks || 0 });
    const msg = (d.actions || []).find((a) => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
    rows.push({ date, metric: 'ad_messages', value: msg ? +msg.value : 0 });
  }
  return { rows };
}

// Encuentra la cuenta de Instagram y la página de Facebook del cliente a partir de su @,
// entre las cuentas que el usuario del sistema de Strove tiene asignadas.
export async function resolveMeta(env, client) {
  const data = await graph(env, 'me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100 });
  const want = String(client.igUsername || '').replace(/^@/, '').toLowerCase();
  const page = (data.data || []).find((p) =>
    (client.fbPageId && p.id === client.fbPageId) ||
    (want && p.instagram_business_account?.username?.toLowerCase() === want) ||
    (client.igUserId && p.instagram_business_account?.id === client.igUserId));
  if (!page) throw new Error(`No encuentro la cuenta ${want ? '@' + want : ''} entre las asignadas al usuario del sistema`);
  return { igUserId: page.instagram_business_account?.id || client.igUserId || null, pageId: page.id, pageToken: page.access_token, pageName: page.name };
}

// Lo que ya está programado en Facebook (Business Suite). Instagram no lo expone por API.
export async function fetchScheduledFacebook(env, pageId, pageToken) {
  const url = new URL(`https://graph.facebook.com/${ver(env)}/${pageId}/scheduled_posts`);
  url.searchParams.set('fields', 'id,message,scheduled_publish_time,full_picture');
  url.searchParams.set('limit', '50');
  url.searchParams.set('access_token', pageToken);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Meta (programados): ${data.error?.message || res.status}`);
  return (data.data || []).map((p) => {
    const iso = new Date((p.scheduled_publish_time || 0) * 1000).toISOString();
    return { id: p.id, caption: (p.message || '').slice(0, 600), thumb: p.full_picture || null, scheduled_at: iso, local_date: localDate(iso),
      time: new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) };
  });
}

// ---------- Datos en vivo para el reporte mensual ----------
async function igTotals(env, igId, metrics, since, until) {
  try {
    const d = await graph(env, `${igId}/insights`, { metric: metrics, period: 'day', metric_type: 'total_value', since, until });
    return Object.fromEntries((d.data || []).map((x) => [x.name, x.total_value?.value ?? null]));
  } catch { return {}; }
}
const ts = (iso, end) => Math.floor(Date.parse(iso + 'T06:00:00Z') / 1000) + (end ? 86400 : 0); // medianoche de Guadalajara

// Totales del mes (alcance único, visitas al perfil, clics al enlace…), demografía de seguidores y pauta anuncio por anuncio
export async function fetchReportLive(env, client, from, to, prevFrom, prevTo) {
  const out = { cur: {}, prev: {}, demo: null, ads: [] };
  if (client.social !== false && (client.igUserId || client.igUsername)) {
    try {
      const meta = await resolveMeta(env, client);
      const ig = meta.igUserId;
      // Instagram acepta rangos de máx. 30 días
      const clamp = (a, b) => { const s = ts(a), e = ts(b, true); return [Math.max(s, e - 30 * 86400), e]; };
      const [s1, e1] = clamp(from, to), [s0, e0] = clamp(prevFrom, prevTo);
      const A = 'reach,views,total_interactions,accounts_engaged', B = 'profile_views,website_clicks';
      const [c1, c2, p1, p2] = await Promise.all([igTotals(env, ig, A, s1, e1), igTotals(env, ig, B, s1, e1), igTotals(env, ig, A, s0, e0), igTotals(env, ig, B, s0, e0)]);
      out.cur = { ...c1, ...c2 }; out.prev = { ...p1, ...p2 };
      const demo = {};
      for (const b of ['age', 'gender', 'city']) {
        try {
          const d = await graph(env, `${ig}/insights`, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: b });
          demo[b] = (d.data?.[0]?.total_value?.breakdowns?.[0]?.results || []).map((r) => ({ label: r.dimension_values?.[0], value: r.value }));
        } catch { /* cuentas con menos de 100 seguidores no tienen demografía */ }
      }
      if (Object.values(demo).some((v) => v?.length)) out.demo = demo;
    } catch { /* sin Instagram en vivo */ }
  }
  if (client.adAccountId || client.adAccountName) {
    try {
      const adId = await resolveAdAccount(env, client);
      const d = await graph(env, `act_${adId}/insights`, { level: 'ad', fields: 'ad_name,ad_id,reach,impressions,spend,clicks,actions', time_range: JSON.stringify({ since: from, until: to }), limit: 100 });
      out.ads = (d.data || []).map((x) => {
        const msg = (x.actions || []).find((a) => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
        return { name: x.ad_name, reach: +x.reach || 0, impressions: +x.impressions || 0, spend: +x.spend || 0, clicks: +x.clicks || 0, messages: msg ? +msg.value : 0 };
      }).filter((x) => x.spend > 0).sort((a, b) => b.spend - a.spend);
    } catch { /* sin desglose de anuncios */ }
  }
  return out;
}

// Inspiración: posts recientes de otra cuenta de Instagram (negocio o creador) vía business_discovery
export async function discoverInstagram(env, username, n = 12) {
  const d = await graph(env, 'me/accounts', { fields: 'instagram_business_account', limit: 50 });
  const ig = (d.data || []).map((p) => p.instagram_business_account?.id).find(Boolean);
  if (!ig) throw new Error('No hay una cuenta de Instagram de Strove para consultar');
  const f = `business_discovery.username(${username}){username,name,biography,followers_count,media_count,media.limit(${n}){caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink}}`;
  let r;
  try { r = await graph(env, ig, { fields: f }); }
  catch (e) { throw new Error(/cannot be found|does not exist|Invalid user/i.test(e.message) ? `@${username} no existe o es una cuenta personal (solo se pueden leer cuentas de negocio o creador)` : e.message); }
  const b = r.business_discovery || {};
  return {
    cuenta: '@' + b.username, nombre: b.name, bio: b.biography, seguidores: b.followers_count, publicaciones: b.media_count,
    posts: (b.media?.data || []).map((m) => ({ fecha: (m.timestamp || '').slice(0, 10), formato: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carrusel' : 'post',
      likes: m.like_count, comentarios: m.comments_count, caption: m.caption || '', link: m.permalink })),
  };
}

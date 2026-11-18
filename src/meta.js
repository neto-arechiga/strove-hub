// Meta (Instagram + pauta) con el token de un "usuario del sistema" del Business Manager de Strove.
// Solo lectura. Lo programado en Business Suite NO se puede leer por API: el calendario vive en el Hub.

const ver = (env) => env.META_API_VERSION || 'v23.0';

async function graph(env, path, params = {}) {
  if (!env.META_TOKEN) throw new Error('Falta el secreto META_TOKEN');
  const url = new URL(`https://graph.facebook.com/${ver(env)}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', env.META_TOKEN);
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
  // Seguidores: Meta solo da el número de hoy; el historial lo vamos guardando nosotros cada noche
  const profile = await graph(env, client.igUserId, { fields: 'followers_count,media_count,username' });
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
  const posts = [];
  for (const m of media.data || []) {
    const p = {
      id: m.id, type: m.media_product_type === 'REELS' ? 'REEL' : m.media_type, caption: (m.caption || '').slice(0, 600),
      permalink: m.permalink, thumb: m.thumbnail_url || m.media_url || null, published_at: m.timestamp,
      local_date: localDate(m.timestamp), likes: m.like_count ?? null, comments: m.comments_count ?? null,
      views: null, reach: null, saves: null, shares: null,
    };
    try {
      const ins = await graph(env, `${m.id}/insights`, { metric: 'views,reach,saved,shares' });
      for (const x of ins.data || []) {
        const v = x.values?.[0]?.value ?? x.total_value?.value ?? null;
        if (x.name === 'views') p.views = v;
        if (x.name === 'reach') p.reach = v;
        if (x.name === 'saved') p.saves = v;
        if (x.name === 'shares') p.shares = v;
      }
    } catch { /* posts muy viejos o de otro tipo pueden no traer insights */ }
    posts.push(p);
  }
  return { rows, posts, username: profile.username };
}

export async function fetchAds(env, client, days) {
  const until = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const data = await graph(env, `act_${client.adAccountId}/insights`, {
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

// Conexión con Google (GA4 Data API y Search Console) usando una cuenta de servicio.
// La cuenta de servicio se agrega como lector en cada propiedad del cliente: sin contraseñas.

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
].join(' ');

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

let cached = null; // { token, exp }

export async function googleToken(env) {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!env.GOOGLE_SA_KEY) throw new Error('Falta el secreto GOOGLE_SA_KEY');
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth: ${data.error_description || data.error || res.status}`);
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

async function gpost(env, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await googleToken(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

const isoDate = (d) => d.toISOString().slice(0, 10);
export function dateRange(days, lagDays = 1) {
  const end = new Date(Date.now() - lagDays * 86400_000);
  const start = new Date(end.getTime() - (days - 1) * 86400_000);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}
const ga4Date = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// ---------- GA4 ----------
export async function fetchGA4(env, client, days) {
  const base = `https://analyticsdata.googleapis.com/v1beta/properties/${client.ga4PropertyId}:runReport`;
  const range = dateRange(days);
  const rows = [];

  const traffic = await gpost(env, base, {
    dateRanges: [range],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    limit: 1000,
  });
  for (const r of traffic.rows || []) {
    const date = ga4Date(r.dimensionValues[0].value);
    rows.push({ date, metric: 'sessions', value: +r.metricValues[0].value });
    rows.push({ date, metric: 'users', value: +r.metricValues[1].value });
  }

  if (client.leadEvent) {
    const leads = await gpost(env, base, {
      dateRanges: [range],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: client.leadEvent } } },
      limit: 1000,
    });
    for (const r of leads.rows || []) rows.push({ date: ga4Date(r.dimensionValues[0].value), metric: 'leads', value: +r.metricValues[0].value });
  }

  const ch = await gpost(env, base, {
    dateRanges: [dateRange(28)],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 8,
  });
  const channels = (ch.rows || []).map((r) => ({ label: r.dimensionValues[0].value, value: +r.metricValues[0].value }));

  return { rows, channels };
}

// ---------- Search Console ----------
export async function fetchGSC(env, client, days) {
  const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(client.gscSite)}/searchAnalytics/query`;
  // Search Console publica con ~2 días de retraso
  const range = dateRange(days, 2);
  const rows = [];
  const daily = await gpost(env, base, { ...range, dimensions: ['date'], rowLimit: 1000 });
  for (const r of daily.rows || []) {
    const date = r.keys[0];
    rows.push({ date, metric: 'clicks', value: r.clicks });
    rows.push({ date, metric: 'impressions', value: r.impressions });
    rows.push({ date, metric: 'position', value: r.position });
  }
  const q = await gpost(env, base, { ...dateRange(28, 2), dimensions: ['query'], rowLimit: 10 });
  const queries = (q.rows || []).map((r) => ({
    label: r.keys[0], value: r.clicks, extra: { impressions: r.impressions, position: r.position, ctr: r.ctr },
  }));
  return { rows, queries };
}

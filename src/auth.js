// Acceso: Cloudflare Access protege el Hub (login con tu correo, después el de tu equipo).
// El Worker además verifica la firma del token de Access para que nadie lo salte.

let certs = null; // { keys, exp }

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

async function accessKeys(team) {
  if (certs && certs.exp > Date.now()) return certs.keys;
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  const data = await res.json();
  certs = { keys: data.keys || [], exp: Date.now() + 3600_000 };
  return certs.keys;
}

// Devuelve el correo de quien entra, o null si no está autorizado.
export async function accessUser(request, env) {
  if (env.DEV_BYPASS === '1') return 'dev@local';
  if (!env.ACCESS_TEAM) return null;
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;
  const [h, p, s] = jwt.split('.');
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    const jwk = (await accessKeys(env.ACCESS_TEAM)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    // Firma válida de NUESTRO equipo de Access y sesión vigente. El AUD se revisa solo si está configurado.
    if (!ok || payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com` || payload.exp * 1000 < Date.now()) return null;
    if (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD)) return null;
    return payload.email || 'usuario';
  } catch {
    return null;
  }
}

// Llave que firma los links de clientes. La genera el Hub al azar la primera vez y la guarda
// en la base de datos que comparten los dos Workers (strove-hub y strove-clientes).
// Nadie la escribe ni la tiene que recordar.
let formKey = null;
async function getFormKey(env) {
  if (formKey) return formKey;
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'form_secret'").first();
  if (!row) {
    const rnd = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('form_secret', ?)").bind(rnd).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'form_secret'").first();
  }
  formKey = row.value;
  return formKey;
}

export async function formToken(env, slug, purpose = 'form') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await getFormKey(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${purpose}:${slug}`)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

export async function checkFormToken(env, slug, token, purpose = 'form') {
  if (!token) return false;
  const expected = await formToken(env, slug, purpose);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

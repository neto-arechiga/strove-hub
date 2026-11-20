// Conector de Claude (MCP) para el Hub: Claude lee el contexto de cada marca y guarda las parrillas
// directo en el calendario. Vive en el Worker público (strove-clientes) en /mcp/<llave>.
// Protocolo: MCP "Streamable HTTP" con respuestas JSON (sin streaming).

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FORMATS = ['post', 'carrusel', 'reel', 'historia'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const INSTRUCTIONS = `Eres el estratega de contenido de Strove (agencia de Guadalajara). Con estas herramientas trabajas sobre el Strove Hub:
1. Antes de proponer nada, llama a contexto_cliente para conocer la marca: qué le funcionó, a qué hora, qué ya se publicó y la estrategia de meses anteriores.
2. Platica la estrategia del mes con Ernesto (objetivo, pilares, series, frecuencia, fechas clave) y guárdala con guardar_estrategia cuando la aprueben.
3. Arma la parrilla post por post (fecha, hora, formato, título, serie, caption con hashtags al final y el guion de cada lámina). Muéstrala completa en el chat y solo llama a guardar_parrilla cuando Ernesto diga que la guardes.
4. Si te pasa @cuentas de inspiración, usa inspiracion_instagram. Si te pasa links de posts sueltos, pídele el caption o una captura (Instagram no deja leerlos desde afuera).
Escribe en español de México, claro y directo, sin frases genéricas.`;

const TOOLS = [
  { name: 'listar_clientes', description: 'Lista los clientes de Strove a los que se les llevan redes, con el estado de su parrilla del mes actual y del siguiente.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'contexto_cliente', description: 'Todo lo que hay que saber de una marca para planear su contenido: perfil, seguidores, mejor hora, posts con mejor y peor resultado (90 días), promedios por formato, lo publicado recientemente, la parrilla planeada y la estrategia de meses anteriores.',
    inputSchema: { type: 'object', properties: { cliente: { type: 'string', description: 'Slug o nombre del cliente (p. ej. "padel-ranch" o "Padel Ranch")' } }, required: ['cliente'] } },
  { name: 'ver_calendario', description: 'Muestra los posts del calendario de un cliente en un mes, con sus captions, guion y estado.',
    inputSchema: { type: 'object', properties: { cliente: { type: 'string' }, mes: { type: 'string', description: 'YYYY-MM' } }, required: ['cliente', 'mes'] } },
  { name: 'inspiracion_instagram', description: 'Lee los posts recientes de una cuenta de Instagram de negocio o creador (caption, formato, likes, comentarios, fecha) para inspirarse. No funciona con cuentas personales.',
    inputSchema: { type: 'object', properties: { usuario: { type: 'string', description: '@ de la cuenta, con o sin arroba' }, cantidad: { type: 'number', description: 'Cuántos posts (máx. 25, default 12)' } }, required: ['usuario'] } },
  { name: 'guardar_estrategia', description: 'Guarda la estrategia acordada para un cliente y mes (objetivo, pilares, series, frecuencia, fechas clave). La próxima vez aparece en contexto_cliente.',
    inputSchema: { type: 'object', properties: { cliente: { type: 'string' }, mes: { type: 'string', description: 'YYYY-MM' }, estrategia: { type: 'string', description: 'La estrategia en texto (puede ser markdown)' } }, required: ['cliente', 'mes', 'estrategia'] } },
  { name: 'guardar_parrilla', description: 'Guarda posts en el calendario del Hub. Si ya existe un post con la misma fecha y título, lo actualiza en vez de duplicarlo. Úsala solo cuando Ernesto apruebe la parrilla.',
    inputSchema: { type: 'object', properties: {
      cliente: { type: 'string' },
      estado: { type: 'string', enum: ['borrador', 'por_aprobar', 'aprobado'], description: 'Estado con el que entran (default borrador)' },
      posts: { type: 'array', items: { type: 'object', properties: {
        fecha: { type: 'string', description: 'YYYY-MM-DD' }, hora: { type: 'string', description: 'HH:MM (24 h), opcional' },
        formato: { type: 'string', enum: FORMATS }, titulo: { type: 'string', description: 'Título interno (máx. 120)' },
        serie: { type: 'string', description: 'Opcional, p. ej. "NAVIDAD EN EUROPA · 01/03"' },
        caption: { type: 'string', description: 'Caption completo, con los hashtags al final (máx. 2,200 caracteres, máx. 30 hashtags)' },
        guion: { type: 'string', description: 'Qué va en cada lámina o escena (para diseño). Una lámina por renglón: "1. …"' },
      }, required: ['fecha', 'formato', 'titulo', 'caption'] } },
    }, required: ['cliente', 'posts'] } },
  { name: 'actualizar_datos', description: 'Trae los datos más recientes de un cliente (Instagram, pauta, sitio) y regresa qué se conectó bien y qué falló. Si el cliente no tiene datos, trae 90 días de historia.',
    inputSchema: { type: 'object', properties: { cliente: { type: 'string' } }, required: ['cliente'] } },
  { name: 'editar_post', description: 'Cambia uno o varios campos de un post del calendario (usa el id que regresa ver_calendario).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, fecha: { type: 'string' }, hora: { type: 'string' }, formato: { type: 'string', enum: FORMATS }, titulo: { type: 'string' }, serie: { type: 'string' }, caption: { type: 'string' }, guion: { type: 'string' }, estado: { type: 'string', enum: ['borrador', 'por_aprobar', 'aprobado'] } }, required: ['id'] } },
];

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

export async function handleMcp(request, env, deps) {
  if (request.method !== 'POST') return new Response('Método no permitido', { status: 405, headers: { allow: 'POST' } });
  let msg;
  try { msg = await request.json(); } catch { return Response.json(rpcErr(null, -32700, 'JSON no válido'), { status: 400 }); }
  const handle = async (m) => {
    if (m.id === undefined || m.id === null) return null; // notificación
    try {
      if (m.method === 'initialize') {
        const v = PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : PROTOCOLS[0];
        return rpc(m.id, { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'Strove Hub', version: '1.0.0' }, instructions: INSTRUCTIONS });
      }
      if (m.method === 'ping') return rpc(m.id, {});
      if (m.method === 'tools/list') return rpc(m.id, { tools: TOOLS });
      if (m.method === 'tools/call') {
        try { return rpc(m.id, await callTool(env, deps, m.params?.name, m.params?.arguments || {})); }
        catch (e) { return rpc(m.id, { ...text(`Error: ${e.message}`), isError: true }); }
      }
      if (m.method === 'resources/list') return rpc(m.id, { resources: [] });
      if (m.method === 'prompts/list') return rpc(m.id, { prompts: [] });
      return rpcErr(m.id, -32601, `Método no soportado: ${m.method}`);
    } catch (e) { return rpcErr(m.id, -32603, e.message); }
  };
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(handle))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(msg);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}

function findClient(deps, q) {
  const s = String(q || '').toLowerCase().trim();
  const c = deps.CLIENTS.find((x) => x.slug === s) || deps.CLIENTS.find((x) => x.name.toLowerCase() === s)
    || deps.CLIENTS.find((x) => x.name.toLowerCase().includes(s) || x.slug.includes(s.replace(/\s+/g, '-')));
  if (!c) throw new Error(`No encuentro el cliente "${q}". Usa listar_clientes.`);
  if (c.social === false) throw new Error(`A ${c.name} no se le llevan redes.`);
  return c;
}
const firstLine = (s, n = 140) => { const t = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || ''; return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hubLink = (env, slug) => `${env.HUB_URL || 'https://strove-hub.netoogare.workers.dev'}/#/c/${slug}/redes`;

async function callTool(env, deps, name, a) {
  const DB = env.DB;
  if (name === 'listar_clientes') {
    const out = [];
    for (const c of deps.CLIENTS.filter((x) => x.social !== false)) {
      const cy = await deps.monthCycle(env, c.slug);
      out.push({ cliente: c.slug, nombre: c.name, instagram: (await deps.withBrand(env, c)).igUsername ? '@' + (await deps.withBrand(env, c)).igUsername : null,
        [`parrilla_${cy.mes}`]: `${cy.cur.total} posts (${cy.cur.approved} aprobados, ${cy.cur.scheduled} en Meta)`,
        [`parrilla_${cy.nextMes}`]: cy.next.total ? `${cy.next.total} posts` : 'sin parrilla' });
    }
    return text(out);
  }

  if (name === 'contexto_cliente') {
    const c = await deps.withBrand(env, findClient(deps, a.cliente));
    const today = deps.mxToday(); const d90 = deps.shift(today, -90), d60 = deps.shift(today, -60), d28 = deps.shift(today, -28);
    const prof = JSON.parse((await DB.prepare('SELECT value FROM settings WHERE key = ?').bind('igprofile:' + c.slug).first())?.value || '{}');
    const fol = await DB.prepare("SELECT value FROM metrics WHERE client = ? AND metric = 'followers' ORDER BY date DESC LIMIT 1").bind(c.slug).first();
    const fol28 = await DB.prepare("SELECT value FROM metrics WHERE client = ? AND metric = 'followers' AND date <= ? ORDER BY date DESC LIMIT 1").bind(c.slug, d28).first();
    const { results: posts } = await DB.prepare('SELECT type, caption, local_date, likes, comments, views, reach, saves, shares FROM posts WHERE client = ? AND local_date >= ? ORDER BY local_date DESC').bind(c.slug, d90).all();
    const score = (p) => (p.reach ?? p.views ?? 0);
    const fmt = (p) => ({ fecha: p.local_date, formato: p.type === 'CAROUSEL_ALBUM' ? 'carrusel' : p.type === 'REEL' || p.type === 'VIDEO' ? 'reel' : 'post', tema: firstLine(p.caption),
      alcance: p.reach, reproducciones: p.views, likes: p.likes, comentarios: p.comments, guardados: p.saves, compartidos: p.shares });
    const sorted = [...posts].sort((x, y) => score(y) - score(x));
    const byType = {};
    for (const p of posts) { const k = fmt(p).formato; (byType[k] ||= []).push(p); }
    const promedios = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { posts: v.length, alcance_promedio: Math.round(v.reduce((s, p) => s + (p.reach || 0), 0) / v.length), guardados_promedio: +(v.reduce((s, p) => s + (p.saves || 0), 0) / v.length).toFixed(1) }]));
    const best = await deps.bestTime(env, c.slug);
    const cy = await deps.monthCycle(env, c.slug);
    const { results: plan } = await DB.prepare("SELECT date, time, format, title, series, status FROM content_plan WHERE client = ? AND date >= ? ORDER BY date").bind(c.slug, d60).all();
    const { results: strat } = await DB.prepare("SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key DESC LIMIT 3").bind(`strategy:${c.slug}:%`).all();
    return text({
      cliente: c.slug, nombre: c.name, instagram: c.igUsername ? '@' + c.igUsername : null, bio: prof.biography || null,
      seguidores: fol?.value ?? prof.followers ?? null, seguidores_hace_28_dias: fol28?.value ?? null,
      mejor_hora: best.hour ? `${best.hour} (según ${best.basis} posts)` : 'sin datos suficientes',
      publicaciones_ultimos_90_dias: posts.length,
      promedios_por_formato: promedios,
      mejores_posts: sorted.slice(0, 8).map(fmt),
      posts_mas_flojos: sorted.slice(-3).reverse().map(fmt),
      publicado_ultimos_60_dias: posts.filter((p) => p.local_date >= d60).map((p) => `${p.local_date} · ${firstLine(p.caption, 90)}`),
      calendario: plan.map((p) => `${p.date}${p.time ? ' ' + p.time : ''} · ${p.format} · ${p.title || ''}${p.series ? ' [' + p.series + ']' : ''} · ${p.status}`),
      estado_del_mes: { [cy.mes]: cy.cur, [cy.nextMes]: cy.next },
      estrategias_anteriores: strat.map((s) => ({ mes: s.key.split(':')[2], estrategia: s.value })),
      hub: hubLink(env, c.slug),
    });
  }

  if (name === 'ver_calendario') {
    const c = findClient(deps, a.cliente);
    if (!/^\d{4}-\d{2}$/.test(a.mes || '')) throw new Error('El mes va como YYYY-MM');
    const { results } = await DB.prepare("SELECT id, date, time, format, title, series, copy, brief, status, client_comment FROM content_plan WHERE client = ? AND substr(date, 1, 7) = ? ORDER BY date, time").bind(c.slug, a.mes).all();
    if (!results.length) return text(`${c.name} no tiene posts en ${MESES[+a.mes.slice(5) - 1]} ${a.mes.slice(0, 4)}.`);
    return text(results.map((p) => ({ id: p.id, fecha: p.date, hora: p.time, formato: p.format, titulo: p.title, serie: p.series, estado: p.status, comentario_cliente: p.client_comment || undefined, caption: p.copy, guion: p.brief || undefined })));
  }

  if (name === 'inspiracion_instagram') {
    const u = String(a.usuario || '').replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/[/?].*$/, '').trim();
    if (!/^[\w.]{1,30}$/.test(u)) throw new Error('Usuario de Instagram no válido');
    if (!env.HUB) throw new Error('El conector no puede leer Instagram en este momento');
    const token = await deps.formToken(env, 'mcp', 'internal');
    const res = await env.HUB.fetch(`https://hub.internal/internal/ig-discovery?u=${encodeURIComponent(u)}&n=${Math.min(25, +a.cantidad || 12)}`, { headers: { 'x-internal': token } });
    let d; try { d = await res.json(); } catch { throw new Error('No se pudo conectar con el Hub para leer Instagram'); }
    if (!res.ok) throw new Error(d.error || 'No se pudo leer la cuenta');
    return text(d);
  }

  if (name === 'guardar_estrategia') {
    const c = findClient(deps, a.cliente);
    if (!/^\d{4}-\d{2}$/.test(a.mes || '')) throw new Error('El mes va como YYYY-MM');
    await DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`strategy:${c.slug}:${a.mes}`, String(a.estrategia || '').slice(0, 12000)).run();
    return text(`Estrategia de ${MESES[+a.mes.slice(5) - 1]} guardada para ${c.name}.`);
  }

  if (name === 'guardar_parrilla') {
    const c = findClient(deps, a.cliente);
    const posts = Array.isArray(a.posts) ? a.posts : [];
    if (!posts.length) throw new Error('No hay posts para guardar');
    if (posts.length > 40) throw new Error('Máximo 40 posts por vez');
    const status = ['borrador', 'por_aprobar', 'aprobado'].includes(a.estado) ? a.estado : 'borrador';
    let created = 0, updated = 0; const ts = new Date().toISOString(); const avisos = [];
    for (const p of posts) {
      const f = toPlan(p);
      if (!f.date) throw new Error(`Falta la fecha en "${p.titulo || '?'}"`);
      const tags = (f.copy || '').match(/#[^\s#]+/g) || [];
      if (tags.length > 30) avisos.push(`"${f.title}" tiene ${tags.length} hashtags (Instagram permite 30)`);
      const ex = await DB.prepare('SELECT id FROM content_plan WHERE client = ? AND date = ? AND lower(trim(title)) = lower(trim(?))').bind(c.slug, f.date, f.title || '').first();
      if (ex) {
        await DB.prepare(`UPDATE content_plan SET ${Object.keys(f).map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...Object.values(f), ts, ex.id).run();
        updated++;
      } else {
        const row = { client: c.slug, network: 'instagram', status, created_by: 'Claude', created_at: ts, updated_at: ts, ...f };
        await DB.prepare(`INSERT INTO content_plan (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
        created++;
      }
    }
    return text(`Listo: ${created} post${created === 1 ? '' : 's'} nuevo${created === 1 ? '' : 's'}${updated ? ` y ${updated} actualizado${updated === 1 ? '' : 's'}` : ''} en el calendario de ${c.name}.${avisos.length ? '\nOjo: ' + avisos.join('; ') : ''}\nVer en el Hub: ${hubLink(env, c.slug)}`);
  }

  if (name === 'actualizar_datos') {
    const c = deps.CLIENTS.find((x) => x.slug === String(a.cliente).toLowerCase()) || findClient(deps, a.cliente);
    if (!env.HUB) throw new Error('El conector no puede pedir la actualización en este momento');
    const has = await DB.prepare('SELECT 1 FROM metrics WHERE client = ? LIMIT 1').bind(c.slug).first();
    const token = await deps.formToken(env, c.slug, 'internal');
    const res = await env.HUB.fetch(`https://hub.internal/internal/sync?client=${c.slug}&days=${has ? 10 : 90}`, { method: 'POST', headers: { 'x-internal': token } });
    let d; try { d = await res.json(); } catch { throw new Error('El Hub no respondió'); }
    const steps = d[c.slug] || [];
    const NAMES = { ga4: 'Analytics', gsc: 'Search Console', instagram: 'Instagram', pauta: 'Pauta', github: 'GitHub', solicitudes: 'Solicitudes', uptime: 'Sitio en línea' };
    return text(steps.map((x) => `${NAMES[x.source] || x.source}: ${x.ok ? 'listo' : 'falló — ' + x.error}`).join('\n') || 'Sin pasos que actualizar');
  }

  if (name === 'editar_post') {
    const f = toPlan(a, true);
    if (a.estado !== undefined) { if (!['borrador', 'por_aprobar', 'aprobado'].includes(a.estado)) throw new Error('Estado no válido'); f.status = a.estado; }
    if (!Object.keys(f).length) throw new Error('Nada que cambiar');
    const row = await DB.prepare(`UPDATE content_plan SET ${Object.keys(f).map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ? RETURNING client, title`).bind(...Object.values(f), new Date().toISOString(), +a.id).first();
    if (!row) throw new Error('No existe ese post');
    return text(`Post "${row.title}" actualizado.`);
  }

  throw new Error(`Herramienta desconocida: ${name}`);
}

function toPlan(p, partial = false) {
  const f = {};
  if (p.fecha !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fecha)) throw new Error(`Fecha no válida: ${p.fecha}`); f.date = p.fecha; }
  if (p.hora !== undefined && p.hora !== '') { if (!/^\d{1,2}:\d{2}$/.test(p.hora)) throw new Error(`Hora no válida: ${p.hora}`); f.time = p.hora.padStart(5, '0'); }
  if (p.formato !== undefined) { if (!FORMATS.includes(p.formato)) throw new Error(`Formato no válido: ${p.formato}`); f.format = p.formato; }
  if (p.titulo !== undefined) f.title = String(p.titulo).slice(0, 120);
  if (p.serie !== undefined) f.series = String(p.serie).slice(0, 80);
  if (p.caption !== undefined) f.copy = String(p.caption).slice(0, 2200);
  if (p.guion !== undefined) f.brief = String(p.guion).slice(0, 4000);
  if (!partial && !f.title) throw new Error('Falta el título');
  return f;
}

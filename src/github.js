// GitHub: último commit, estado del deploy y solicitudes de cambio como Issues.

async function gh(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new Error('Falta el secreto GITHUB_TOKEN');
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'strove-hub',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data?.message || ''}`);
  return data;
}

// Último commit en la rama principal y cómo le fue al deploy (check de Cloudflare Workers Builds)
export async function fetchDeploy(env, client) {
  const commit = await gh(env, `/repos/${client.repo}/commits/${client.branch || 'main'}`);
  let state = 'unknown';
  try {
    const checks = await gh(env, `/repos/${client.repo}/commits/${commit.sha}/check-runs?per_page=20`);
    const runs = checks.check_runs || [];
    if (runs.some((r) => r.status !== 'completed')) state = 'pending';
    else if (runs.some((r) => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion))) state = 'failure';
    else if (runs.length) state = 'success';
  } catch { /* el token puede no tener permiso de Checks: queda unknown */ }
  return {
    sha: commit.sha.slice(0, 7),
    message: (commit.commit.message || '').split('\n')[0].slice(0, 140),
    date: commit.commit.committer?.date || commit.commit.author?.date,
    state,
  };
}

export async function createIssue(env, client, req) {
  const body = [
    req.detail || '',
    '',
    '---',
    `**Cliente:** ${client.name}`,
    `**Pidió:** ${req.requester || '—'} (${req.source === 'cliente' ? 'formulario del cliente' : 'capturada por Strove'})`,
    `**Solicitud #${req.id} en Strove Hub**`,
  ].join('\n');
  const issue = await gh(env, `/repos/${client.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: req.title, body, labels: ['solicitud'] }),
  });
  return { number: issue.number, url: issue.html_url };
}

// Lee el issue y deduce el estado: cerrado = publicada; con PR abierto = en revisión
export async function issueState(env, client, number) {
  const issue = await gh(env, `/repos/${client.repo}/issues/${number}`);
  if (issue.state === 'closed') return issue.state_reason === 'not_planned' ? 'descartada' : 'publicada';
  try {
    const tl = await gh(env, `/repos/${client.repo}/issues/${number}/timeline?per_page=50`);
    const pr = tl.find((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request && e.source.issue.state === 'open');
    if (pr) return 'en_revision';
  } catch { /* sin timeline: seguimos con el estado abierto */ }
  return (issue.assignees || []).length ? 'en_proceso' : null;
}

-- Strove Hub · estructura de la base de datos (D1)
-- Aplicar:  npx wrangler d1 execute strove-hub --remote --file=schema.sql

-- Números diarios por cliente y fuente (ga4, gsc)
CREATE TABLE IF NOT EXISTS metrics (
  client TEXT NOT NULL,
  source TEXT NOT NULL,
  date   TEXT NOT NULL,          -- YYYY-MM-DD
  metric TEXT NOT NULL,          -- sessions, users, leads, clicks, impressions, position
  value  REAL NOT NULL,
  PRIMARY KEY (client, source, date, metric)
);

-- Rankings que se reemplazan en cada corrida (keywords, canales)
CREATE TABLE IF NOT EXISTS breakdowns (
  client TEXT NOT NULL,
  kind   TEXT NOT NULL,          -- queries, channels
  rank   INTEGER NOT NULL,
  label  TEXT NOT NULL,
  value  REAL NOT NULL,          -- clics (queries) o sesiones (channels)
  extra  TEXT,                   -- JSON con datos extra (impresiones, posición)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client, kind, rank)
);

-- Estado del sitio: disponibilidad y último deploy
CREATE TABLE IF NOT EXISTS site_status (
  client       TEXT PRIMARY KEY,
  checked_at   TEXT,
  http_status  INTEGER,
  response_ms  INTEGER,
  commit_sha   TEXT,
  commit_msg   TEXT,
  commit_date  TEXT,
  deploy_state TEXT,             -- success, failure, pending, unknown
  updated_at   TEXT
);

-- Solicitudes de cambio
CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client       TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  source       TEXT NOT NULL,    -- interno | cliente
  requester    TEXT,
  status       TEXT NOT NULL DEFAULT 'nueva',  -- nueva, en_proceso, en_revision, publicada, descartada
  issue_number INTEGER,
  issue_url    TEXT,
  preview_url  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_client ON requests (client, status);

-- Logos subidos desde el Hub (reemplazan al de public/logos)
CREATE TABLE IF NOT EXISTS logos (
  client     TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,      -- base64
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- Bitácora de cada corrida de recolección
CREATE TABLE IF NOT EXISTS sync_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at  TEXT NOT NULL,
  client  TEXT NOT NULL,
  source  TEXT NOT NULL,
  ok      INTEGER NOT NULL,
  message TEXT
);

-- ===================== Fase 2 · Redes =====================

-- Posts publicados en Instagram (se refrescan cada noche)
CREATE TABLE IF NOT EXISTS posts (
  client     TEXT NOT NULL,
  id         TEXT NOT NULL,
  network    TEXT NOT NULL DEFAULT 'instagram',
  type       TEXT,               -- IMAGE, VIDEO, CAROUSEL_ALBUM / REELS, FEED, STORY
  caption    TEXT,
  permalink  TEXT,
  thumb      TEXT,
  published_at TEXT,             -- ISO UTC
  local_date TEXT,               -- YYYY-MM-DD en hora de Guadalajara
  likes      INTEGER, comments INTEGER, views INTEGER, reach INTEGER, saves INTEGER, shares INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client, id)
);
CREATE INDEX IF NOT EXISTS posts_date ON posts (client, local_date);

-- Calendario de contenido (planeado en el Hub, aprobado por el cliente, programado en Business Suite)
CREATE TABLE IF NOT EXISTS content_plan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client        TEXT NOT NULL,
  date          TEXT NOT NULL,   -- YYYY-MM-DD
  time          TEXT,            -- HH:MM
  network       TEXT NOT NULL DEFAULT 'instagram',  -- instagram, facebook, ambas
  format        TEXT NOT NULL DEFAULT 'post',       -- post, carrusel, reel, historia
  title         TEXT,
  series        TEXT,            -- serie del post (p. ej. "NAVIDAD EN EUROPA · 01/03")
  copy          TEXT,
  image         TEXT,            -- data URL (se comprime en el navegador antes de subir)
  status        TEXT NOT NULL DEFAULT 'borrador',   -- borrador, por_aprobar, cambios, aprobado, programado, publicado
  client_comment TEXT,
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  post_id       TEXT,            -- post de Instagram con el que se empató
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_client_date ON content_plan (client, date);

-- Ajustes internos (p. ej. la llave que firma los links de clientes)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Lo que ya está programado en Meta (hoy: Facebook; Instagram no lo expone por API)
CREATE TABLE IF NOT EXISTS scheduled_posts (
  client     TEXT NOT NULL,
  network    TEXT NOT NULL,
  id         TEXT NOT NULL,
  caption    TEXT,
  thumb      TEXT,
  scheduled_at TEXT,
  local_date TEXT,
  time       TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client, network, id)
);

-- Láminas de cada post del calendario (carruseles), en orden
CREATE TABLE IF NOT EXISTS plan_slides (
  plan_id INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  image   TEXT NOT NULL,         -- data URL
  PRIMARY KEY (plan_id, idx)
);

-- Kit de marca de cada cliente (colores, @ de Instagram, foto de portada) editable desde el Hub
CREATE TABLE IF NOT EXISTS brands (
  client     TEXT PRIMARY KEY,
  data       TEXT NOT NULL,      -- JSON: { dark, accent, light, ig }
  cover      TEXT,               -- data URL de la foto de portada (opcional)
  updated_at TEXT NOT NULL
);

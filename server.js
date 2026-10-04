import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

// Serves the captured kixmax.co mirror and replaces the two things static HTML cannot do:
// Elementor form submissions and search. WordPress/PHP itself is not emulated.
//
// This process is the whole web server: it terminates TLS-terminated traffic directly, so
// compression, conditional requests and byte ranges are handled here rather than by a
// reverse proxy.
const root = path.resolve(process.env.MIRROR_SITE_DIR || process.env.MIRROR_OUTPUT || 'kixmax-site');
const dataDir = path.resolve(process.env.MIRROR_DATA_DIR || 'data');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
// Enable only when a reverse proxy in front of this process sets X-Forwarded-For, so the
// rate limiter can still see the real client address.
const trustProxy = process.env.MIRROR_TRUST_PROXY === '1';
const maxBody = 6 * 1024 * 1024;
const maxAttachment = 5 * 1024 * 1024;
const maxField = 8000;
const minCompress = 1024;

await fs.mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'mirror.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY, page TEXT NOT NULL, form_name TEXT, form_id TEXT,
  referer_title TEXT, fields TEXT NOT NULL,
  attachment_name TEXT, attachment_type TEXT, attachment BLOB,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
const insertSubmission = db.prepare(
  'INSERT INTO submissions (page,form_name,form_id,referer_title,fields,attachment_name,attachment_type,attachment) VALUES (?,?,?,?,?,?,?,?)');
const attempts = new Map();

const mime = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.cur': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.zip': 'application/zip'
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const compressible = /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json|rss|atom\+xml)|image\/svg\+xml)/i;
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN'
};
function encodingFor(req, type, size) {
  if (size < minCompress || !compressible.test(type)) return null;
  const accepted = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}
function send(req, res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const encoding = encodingFor(req, type, payload.length);
  const out = { ...securityHeaders, ...headers };
  if (encoding) {
    const compressed = encoding === 'br'
      ? zlib.brotliCompressSync(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
      : zlib.gzipSync(payload, { level: 6 });
    out['content-encoding'] = encoding;
    out.vary = out.vary ? `${out.vary}, Accept-Encoding` : 'Accept-Encoding';
    out['content-length'] = compressed.length;
    res.writeHead(status, { 'content-type': type, ...out });
    return req.method === 'HEAD' ? res.end() : res.end(compressed);
  }
  out['content-length'] = payload.length;
  res.writeHead(status, { 'content-type': type, ...out });
  return req.method === 'HEAD' ? res.end() : res.end(payload);
}
function clientError(req, res, status, message) {
  send(req, res, status, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
}
function authorized(req) {
  const token = process.env.MIRROR_ADMIN_TOKEN;
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`;
}
function rateLimit(req) {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(time => now - time < 60000);
  if (recent.length >= 5) return false;
  recent.push(now);
  attempts.set(ip, recent);
  return true;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw Object.assign(new Error('Request exceeds 6 MB'), { status: 413 });
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

// Elementor posts multipart form data; the injected client script posts JSON. Accept both.
async function readPayload(req, url) {
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    const body = await readBody(req);
    const parsed = JSON.parse(body.toString('utf8') || '{}');
    const fields = {};
    let attachment = null;
    for (const [key, value] of Object.entries(parsed.fields || {})) {
      if (value && typeof value === 'object' && value.data) {
        if (attachment) continue;
        attachment = { name: String(value.name || 'attachment').slice(0, 255), type: String(value.type || '').slice(0, 100), bytes: Buffer.from(String(value.data), 'base64') };
      } else fields[key] = String(value ?? '').trim().slice(0, maxField);
    }
    return {
      page: String(parsed.page || '').slice(0, 1000),
      formName: parsed.formName ? String(parsed.formName).slice(0, 200) : null,
      formId: parsed.formId ? String(parsed.formId).slice(0, 100) : null,
      refererTitle: parsed.refererTitle ? String(parsed.refererTitle).slice(0, 300) : null,
      fields, attachment
    };
  }
  const body = await readBody(req);
  const form = await new Request(url, { method: 'POST', headers: { 'content-type': type }, body }).formData();
  const fields = {};
  let attachment = null;
  let page = '';
  let formName = null;
  let formId = null;
  let refererTitle = null;
  for (const [key, value] of form) {
    if (['_wpnonce', '_wp_http_referer', 'elementor-form-id', 'cf-turnstile-response', 'g-recaptcha-response', 'website'].includes(key)) continue;
    if (value instanceof File) { if (value.size && !attachment) attachment = value; continue; }
    const text = String(value).trim().slice(0, maxField);
    if (key === 'referer_title') refererTitle = text.slice(0, 300);
    else if (key === 'form_id') formId = text.slice(0, 100);
    else if (key === 'page' || key === 'PagePath') page = text.slice(0, 1000);
    else if (key.startsWith('form_fields[') && key.endsWith(']')) fields[key.slice('form_fields['.length, -1)] = text;
    else fields[key] = text;
  }
  return { page, formName, formId, refererTitle, fields, attachment };
}

async function searchIndex() {
  const results = [];
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'data') continue;
      const name = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.name.endsWith('.html')) {
        const html = await fs.readFile(name, 'utf8');
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || entry.name).replace(/<[^>]+>/g, '').trim();
        const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 30000);
        results.push({ title, body, url: '/' + path.relative(root, name).split(path.sep).join('/') });
      }
    }
  }
  await visit(root);
  return results;
}
const indexedPages = await searchIndex();
function searchPage(query) {
  const q = query.trim().slice(0, 100);
  const terms = q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = terms.length
    ? indexedPages.filter(page => terms.every(term => (page.title + ' ' + page.body).toLocaleLowerCase().includes(term))).slice(0, 100)
    : [];
  const items = found.map(page => `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Search | KixMax</title><style>body{font:1.05rem/1.6 system-ui,sans-serif;max-width:820px;margin:3rem auto;padding:1rem;color:#111}`
    + `input[type=search]{padding:.6rem;width:70%}button{padding:.6rem 1.2rem}li{margin:.7rem 0}a{color:#a2761a}</style></head><body>`
    + `<a href="/">&larr; Home</a><h1>Search</h1>`
    + `<form action="/search/" method="get"><input type="search" name="q" value="${escapeHtml(q)}" autofocus><button>Search</button></form>`
    + `<p>${found.length} result${found.length === 1 ? '' : 's'}</p><ul>${items}</ul></body></html>`;
}

const clientJs = await fs.readFile(new URL('./server-client.js', import.meta.url), 'utf8');

// The captured markup still carries the original site's analytics, Google Tag Manager and
// Cloudflare RUM beacons. Left in place they would report this mirror's visitors to the old
// property, so they are removed while the page is served. Map embeds are left alone: they are
// ordinary iframes and do not report page views.
const trackingHosts = /(?:googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|cloudflareinsights\.com|gtag\/js|analytics\.js|gtm\.js)/i;
const rumScript = /<script[^>]*\bsrc=["'][^"']*\/cdn-cgi\/rum[^"']*["'][^>]*>[\s\S]*?<\/script>/gi;
const rumInline = /<script[^>]*>\s*\(\s*function\s*\(\s*w\s*,\s*d\s*,\s*s\s*,\s*l\s*,\s*i\s*\)[\s\S]*?<\/script>/gi;
function stripTracking(html) {
  return html
    .replace(rumScript, '')
    .replace(rumInline, '')
    .replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>[\s\S]*?<\/script>/gi, tag => (trackingHosts.test(tag) ? '' : tag))
    .replace(/<noscript>\s*<iframe[^>]*(?:googletagmanager|doubleclick)[^>]*>[\s\S]*?<\/noscript>/gi, '')
    // WP Rocket defers all scripts by setting type="rocketlazyloadscript" so its own
    // loader can activate them on scroll. In the mirror there is no WP Rocket runtime,
    // so those scripts never fire. Restore them to normal <script> tags so Elementor,
    // WooCommerce and the nav widget JS all initialise on page load.
    .replace(/\btype="rocketlazyloadscript"/g, '')
    .replace(/\bdata-rocket-[a-z0-9_-]+="[^"]*"/g, '')
    .replace(/\bdata-rocketlazyloadscript="[^"]*"/g, '');
}

// The language switcher stores its choice in the `mirror-lang` cookie. For right-to-left
// languages the page is served already mirrored — dir="rtl", WordPress's body.rtl class and
// the flipped stylesheets build-rtl.js writes beside each original — so sliders and menus
// initialise in the right direction instead of being flipped after the fact.
const rtlLangs = new Set(['fa', 'dari', 'ar', 'ur', 'ku']);
const wantsRtl = req => rtlLangs.has(/(?:^|;\s*)mirror-lang=([^;]+)/.exec(req.headers.cookie || '')?.[1]);
function mirrorToRtl(html) {
  return html
    .replace(/<html\b/i, '<html dir="rtl"')
    .replace(/(<body\b[^>]*?\bclass=["'])/i, '$1rtl ')
    .replace(/(<link\b[^>]*?\bhref=["'])(?!https?:|\/\/)([^"'?#]+)\.css(?=[?#"'])/gi, '$1$2.rtl.css');
}

async function resolveFile(pathname) {
  const candidates = pathname.endsWith('/')
    ? [pathname + 'index.html']
    : [pathname, pathname + '/index.html', pathname + '.html'];
  for (const candidate of candidates) {
    let name;
    try { name = decodeURIComponent(candidate); } catch { continue; }
    const target = path.resolve(root, '.' + name);
    if (!target.startsWith(root + path.sep)) continue;
    try {
      const stat = await fs.stat(target);
      if (stat.isFile() && stat.size) return { target, stat };
    } catch { /* try the next shape */ }
  }
  // WP Rocket background-css files are versioned with a hash suffix (name--HASH.css).
  // When the page references a hash we didn't capture, fall back to any sibling with
  // the same base name captured from a different page load.
  const hashMatch = pathname.match(/^(.*?)--[0-9a-f]{8,}(\.(?:css|js))$/i);
  if (hashMatch) {
    try {
      const decoded = decodeURIComponent(hashMatch[1]);
      const ext = hashMatch[2];
      const dir = path.resolve(root, '.' + path.posix.dirname(decoded));
      const stem = path.posix.basename(decoded);
      if (dir.startsWith(root + path.sep)) {
        const entries = await fs.readdir(dir);
        const match = entries.find(e => e.startsWith(stem + '--') && e.endsWith(ext));
        if (match) {
          const target = path.join(dir, match);
          const stat = await fs.stat(target);
          if (stat.isFile() && stat.size) return { target, stat };
        }
      }
    } catch { /* dir missing or unreadable — fall through to 404 */ }
  }
  return null;
}
// Parses a single-range "bytes=start-end" header. Multi-range requests are answered with the
// whole file, which is legal and simpler than assembling a multipart body.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    const length = Number(rawEnd);
    if (!length) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

async function serveFile(req, res, pathname) {
  // A stylesheet without a generated RTL twin falls back to the original.
  const found = await resolveFile(pathname)
    || (pathname.endsWith('.rtl.css') ? await resolveFile(pathname.slice(0, -'.rtl.css'.length) + '.css') : null);
  if (!found) return send(req, res, 404, 'Not found');
  const { target, stat } = found;
  const type = mime[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();
  const base = { etag, 'last-modified': lastModified, 'accept-ranges': 'bytes' };

  if (type.startsWith('text/html')) {
    const body = await fs.readFile(target, 'utf8');
    let html = stripTracking(body).replace(/<\/body>/i, '<script src="/mirror-app.js" defer></script></body>');
    const rtl = wantsRtl(req);
    if (rtl) html = mirrorToRtl(html);
    const etagForHtml = `W/"${rtl ? 'rtl-' : ''}${html.length.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etagForHtml) {
      res.writeHead(304, { ...securityHeaders, etag: etagForHtml, 'cache-control': 'no-cache', vary: 'Cookie' });
      return res.end();
    }
    return send(req, res, 200, html, type, { ...base, etag: etagForHtml, 'cache-control': 'no-cache', vary: 'Cookie' });
  }

  const immutable = /\.[0-9a-f]{10}\.[a-z0-9]+$/i.test(pathname);
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...securityHeaders, ...base, 'cache-control': cacheControl });
    return res.end();
  }

  // <video> and <audio> seek with Range requests, so a bare 200 makes them unplayable.
  const range = parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    return send(req, res, 416, '', type, { ...base, 'content-range': `bytes */${stat.size}` });
  }
  const encoding = range ? null : encodingFor(req, type, stat.size);
  const headers = {
    ...securityHeaders,
    ...base,
    'cache-control': cacheControl,
    ...(range
      ? { 'content-range': `bytes ${range.start}-${range.end}/${stat.size}`, 'content-length': range.end - range.start + 1 }
      : encoding
        ? { 'content-encoding': encoding, vary: 'Accept-Encoding' }
        : { 'content-length': stat.size })
  };
  res.writeHead(range ? 206 : 200, { 'content-type': type, ...headers });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(target, range ? { start: range.start, end: range.end } : undefined);
  if (encoding) {
    const compressor = encoding === 'br' ? zlib.createBrotliCompress() : zlib.createGzip({ level: 6 });
    stream.on('error', () => res.destroy());
    stream.pipe(compressor).pipe(res);
    return;
  }
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/mirror-app.js') return send(req, res, 200, clientJs, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && pathname === '/health') return send(req, res, 200, 'ok');
    if (req.method === 'GET' && pathname === '/search/') return send(req, res, 200, searchPage(url.searchParams.get('q') || url.searchParams.get('s') || ''), 'text/html; charset=utf-8');
    // WordPress search is /?s=term; the mirror has no PHP to answer it, so search locally.
    if (req.method === 'GET' && pathname === '/' && url.searchParams.has('s')) {
      return send(req, res, 200, searchPage(url.searchParams.get('s') || ''), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/api/submissions') {
      if (!authorized(req)) return clientError(req, res, 401, 'Unauthorized');
      const rows = db.prepare('SELECT id,page,form_name,form_id,referer_title,fields,attachment_name,attachment_type,created_at FROM submissions ORDER BY id DESC LIMIT 1000').all();
      return send(req, res, 200, JSON.stringify(rows), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
    }
    if (req.method === 'GET' && /^\/api\/submissions\/\d+\/attachment$/.test(pathname)) {
      if (!authorized(req)) return clientError(req, res, 401, 'Unauthorized');
      const row = db.prepare('SELECT attachment_name,attachment_type,attachment FROM submissions WHERE id=?').get(Number(pathname.split('/')[3]));
      if (!row?.attachment) return send(req, res, 404, 'Not found');
      const filename = (row.attachment_name || 'attachment').replace(/[\r\n"\\/]/g, '_');
      return send(req, res, 200, row.attachment, row.attachment_type || 'application/octet-stream', {
        'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store'
      });
    }
    if (req.method === 'POST' && pathname === '/api/forms') {
      if (!sameOrigin(req)) return clientError(req, res, 403, 'Invalid origin');
      if (!rateLimit(req)) return clientError(req, res, 429, 'Too many submissions, please wait a minute');
      const payload = await readPayload(req, url);
      if (payload.fields.website) return send(req, res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      if (!Object.keys(payload.fields).length) return clientError(req, res, 400, 'The form was empty');
      let bytes = null;
      if (payload.attachment) {
        bytes = payload.attachment instanceof File
          ? Buffer.from(await payload.attachment.arrayBuffer())
          : payload.attachment.bytes;
        if (bytes.length > maxAttachment) return clientError(req, res, 413, 'Attachment exceeds 5 MB');
      }
      insertSubmission.run(
        payload.page || (req.headers.referer || '').slice(0, 1000),
        payload.formName, payload.formId, payload.refererTitle,
        JSON.stringify(payload.fields),
        payload.attachment?.name?.slice(0, 255) || null,
        payload.attachment?.type?.slice(0, 100) || null,
        bytes);
      return send(req, res, 200, JSON.stringify({ ok: true, message: 'Thank you. Your message has been received.' }), 'application/json; charset=utf-8');
    }
    // A Cloudflare RUM beacon can survive the strip above if it was cached. Swallow it
    // instead of letting the browser retry a 404 on every page view.
    if (pathname === '/cdn-cgi/rum') return send(req, res, 204, '');
    // Elementor, Woodmart and the Turnstile plugin all call admin-ajax.php. There is no PHP
    // here, so answer with an empty JSON object instead of a 404 that breaks their handlers.
    if (/^\/wp-admin\/admin-ajax\.php$/.test(pathname) || /^\/wp-admin\//.test(pathname)) {
      if (req.method !== 'GET' && req.method !== 'POST') return send(req, res, 405, 'Method not allowed');
      return send(req, res, 200, '{}', 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, pathname);
    return send(req, res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    const status = error.status || 500;
    return clientError(req, res, status, status === 413 ? error.message : 'Server error');
  }
});
server.listen(port, host, () => console.log(`KixMax mirror: http://localhost:${port} (${indexedPages.length} indexed pages)`));

// A container stop sends SIGTERM. Drain in-flight requests, then close SQLite so WAL data
// is checkpointed instead of left for the next start to recover.
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, closing`);
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      clearTimeout(force);
      process.exit(0);
    });
  });
}

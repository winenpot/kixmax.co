import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// kixmax.co is a WordPress site (Woodmart theme + Elementor Pro, behind Cloudflare).
// Same-host capture is enough for HTML, CSS, JS, fonts, images and videos; third-party
// hosts such as Google Fonts, GTM and Turnstile are recorded in the report instead.
const base = new URL(process.env.MIRROR_URL || 'https://kixmax.co/');
const output = path.resolve(process.env.MIRROR_OUTPUT || 'kixmax-site');
const maxPages = Number(process.env.MIRROR_MAX_PAGES || 2000);
const timeoutMs = Number(process.env.MIRROR_TIMEOUT_MS || 60000);
const refresh = process.env.MIRROR_REFRESH === '1';
// referenced (default) = only assets the rendered pages actually request.
// all = additionally download every original in the WordPress media library (~580 MB).
const media = process.env.MIRROR_MEDIA === 'all' ? 'all' : 'referenced';
// Attachment pages (/parent/attachment-slug/) are public but rarely linked. Off by default.
const captureAttachments = process.env.MIRROR_ATTACHMENTS === '1';
const concurrency = Math.max(1, Number(process.env.MIRROR_CONCURRENCY || 6));
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const pageQueue = [base.href];
const queuedPages = new Set(pageQueue);
const assetQueue = new Set();
const pages = new Map();
const assets = new Map();
const failures = [];
const externalResources = new Set();
const forms = [];
const responseTasks = new Set();
const missingAttachments = [];
const assetExt = /\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|cur|bmp|woff2?|ttf|eot|otf|pdf|mp4|m4v|webm|mov|mp3|wav|ogg|json|xml|txt|webmanifest)$/i;
// WordPress plumbing, private endpoints and generated feeds cannot be mirrored as pages.
const ignoredPath = /\/(?:wp-admin|wp-login\.php|wp-cron\.php|wp-signup\.php|wp-trackback\.php|wp-mail\.php|wp-activate\.php|wp-comments-post\.php|xmlrpc\.php|wp-json|feed)(?:\/|\.|$)/i;
// Query URLs that are not pages of their own: WordPress search and cart plumbing, plus the
// two families that only produce hashed, redundant duplicates of a page we already have.
// ?cms_block= is a Woodmart CMS block, already inlined in every page that uses it, and
// ?p=/?page_id= is the numeric alias of a page that already has a permalink. Mirroring them
// fills the output with index--<hash>.html files that add nothing to the site.
const ignoredQuery = /[?&](?:s|replytocom|share|add-to-cart|remove-from-cart|rest_route|add-to-wishlist|cms_block|p|page_id)=/i;
function isIgnored(url) {
  const parsed = new URL(url);
  return ignoredPath.test(parsed.pathname) || ignoredQuery.test(parsed.search);
}

function urlOf(value, relativeTo = base.href) {
  try {
    const result = new URL(value, relativeTo);
    if (!['http:', 'https:'].includes(result.protocol) || result.host !== base.host) return null;
    result.hash = '';
    return result.href;
  } catch { return null; }
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10); }
// Woodmart pagination uses ?woo_ajax=1 for its JSON fragments. The plain paginated
// page is the mirrorable equivalent, so drop the AJAX flag before queueing.
function normalize(value, relativeTo = base.href) {
  const url = urlOf(value, relativeTo);
  if (!url) return null;
  const parsed = new URL(url);
  // Deleting the last parameter empties .search, and href then drops the "?" entirely, so
  // the result stays an absolute URL: callers hand these straight to new URL().
  if (parsed.searchParams.has('woo_ajax')) parsed.searchParams.delete('woo_ajax');
  // A bare "?" is a legacy IE font hack, not a real query string.
  return parsed.href.endsWith('?') ? parsed.href.slice(0, -1) : parsed.href;
}
function localPath(url, page = false) {
  const parsed = new URL(url);
  let name;
  try { name = decodeURIComponent(parsed.pathname); } catch { name = parsed.pathname; }
  if (page) {
    if (name.endsWith('/')) name += 'index.html';
    else if (!path.extname(name)) name += '/index.html';
  } else if (name.endsWith('/')) return null;
  if (parsed.search) {
    const ext = path.extname(name);
    name = `${name.slice(0, -ext.length || undefined)}--${hash(parsed.search)}${ext}`;
  }
  // URL paths are untrusted input. Keep writes strictly inside output.
  const safe = path.posix.normalize(name).replace(/^\/+/, '');
  if (!safe || safe === '..' || safe.startsWith('../') || safe.includes('\0')) return null;
  return safe;
}
// Local URL that a browser should request, relative to the file `from` that references it,
// so the mirror works both over HTTP and opened straight from disk (file://). Page links keep
// an explicit index.html because file:// has no directory index. URLs inside scripts keep
// the directory form (keepIndex = false): Elementor builds asset URLs from those base paths.
function publicUrl(name, page, parsed, from, keepIndex = true) {
  let target = path.posix.relative(path.posix.dirname(from), name) || path.posix.basename(name);
  if (page && !keepIndex && path.posix.basename(target) === 'index.html') {
    target = target.slice(0, -'index.html'.length) || './';
  }
  return `${target}${parsed.hash}`;
}
function enqueuePage(url) {
  if (!url || isIgnored(url) || queuedPages.has(url)) return;
  queuedPages.add(url);
  pageQueue.push(url);
}
function enqueueAsset(url) {
  if (url && !isIgnored(url) && !assetQueue.has(url)) assetQueue.add(url);
}
function enqueueLink(value, relativeTo = base.href) {
  const url = normalize(value, relativeTo);
  if (!url) return;
  if (assetExt.test(new URL(url).pathname)) enqueueAsset(url);
  else enqueuePage(url);
}
async function save(name, data) {
  const target = path.resolve(output, name);
  if (!target.startsWith(output + path.sep)) throw new Error(`Unsafe path: ${name}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}
async function savedFileExists(name) {
  try { return (await fs.stat(path.join(output, name))).size > 0; }
  catch { return false; }
}
async function get(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': userAgent } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) error.retryable = false;
        throw error;
      }
      return response;
    } catch (error) {
      if (attempt === 2 || error.retryable === false) throw error;
    }
  }
}
async function json(url) {
  const response = await get(url);
  return response.json();
}
// A stalled response must not outlive the page that triggered it: Puppeteer's buffer() has
// no timeout of its own, and one hung body used to block the page phase forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, fail) => setTimeout(() => fail(new Error(`${label} timed out`)), ms))
  ]);
}
async function captureResponse(response) {
  const url = urlOf(response.url());
  if (!url || assets.has(url) || response.status() < 200 || response.status() >= 300) return;
  const type = response.headers()['content-type'] || '';
  try {
    const body = await withTimeout(response.buffer(), timeoutMs, url);
    const name = localPath(url);
    if (!name || type.includes('text/html')) return;
    let outputBody = body;
    if (type.includes('text/css') || name.endsWith('.css')) {
      const css = body.toString('utf8');
      for (const child of cssUrls(css)) enqueueAsset(urlOf(child, url));
      outputBody = Buffer.from(rewriteCss(css, url, name));
    }
    await save(name, outputBody);
    assets.set(url, { file: name, bytes: outputBody.length, type });
  } catch { /* A response can disappear or stall during navigation. */ }
}
async function discoverSitemap(url, seen = new Set()) {
  if (!url || seen.has(url)) return;
  seen.add(url);
  try {
    const xml = await (await get(url)).text();
    for (const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      const child = normalize(match[1].replaceAll('&amp;', '&'));
      if (!child) continue;
      if (/\.xml(?:\?|$)/i.test(child)) await discoverSitemap(child, seen);
      else enqueueLink(child);
    }
  } catch { /* Sitemap is optional; the REST API and link crawl remain the primary sources. */ }
}
// The WordPress REST API knows every published page even when the navigation hides it.
async function discoverRest() {
  const root = `${base.origin}/wp-json/wp/v2/`;
  let types;
  try { types = await json(`${root}types`); } catch { return; }
  const restBases = new Set();
  for (const type of Object.values(types || {})) {
    if (!type?.rest_base || ['attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part', 'wp_navigation', 'wp_font_family', 'wp_font_face', 'wp_global_styles'].includes(type.slug)) continue;
    restBases.add(type.rest_base);
  }
  let taxonomies;
  try { taxonomies = await json(`${root}taxonomies`); } catch { taxonomies = null; }
  for (const taxonomy of Object.values(taxonomies || {})) {
    for (const type of taxonomy.types || []) {
      const baseType = Object.values(types || {}).find(item => item.slug === type);
      if (baseType?.rest_base) restBases.add(baseType.rest_base);
    }
  }
  for (const restBase of restBases) {
    for (const page of [1, 2, 3, 4, 5]) {
      let items;
      try { items = await json(`${root}${restBase}?per_page=100&page=${page}&_fields=link`); }
      catch { break; }
      if (!Array.isArray(items) || !items.length) break;
      for (const item of items) enqueueLink(item.link);
      if (items.length < 100) break;
    }
  }
  for (const taxonomy of Object.values(taxonomies || {})) {
    if (!taxonomy.rest_base) continue;
    for (const page of [1, 2]) {
      let terms;
      try { terms = await json(`${root}${taxonomy.rest_base}?per_page=100&page=${page}&_fields=link,count`); }
      catch { break; }
      if (!Array.isArray(terms) || !terms.length) break;
      for (const term of terms) if (term.count > 0) enqueueLink(term.link);
      if (terms.length < 100) break;
    }
  }
  if (media === 'all' || captureAttachments) {
    for (const page of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      let items;
      try { items = await json(`${root}media?per_page=100&page=${page}&_fields=source_url,link`); }
      catch { break; }
      if (!Array.isArray(items) || !items.length) break;
      for (const item of items) {
        if (item.source_url) enqueueAsset(normalize(item.source_url));
        if (captureAttachments && item.link) enqueueLink(item.link);
      }
      if (items.length < 100) break;
    }
  }
}
function rewriteOne(raw, source, kind, from) {
  if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(raw.trim())) return raw;
  const target = urlOf(raw, source);
  if (!target) return raw;
  // Don't create a local path for URLs the scraper will never capture — they'd become dead
  // hashed references like index--24a21e10d0.html that nothing on disk can satisfy.
  if (isIgnored(target)) return raw;
  const parsed = new URL(raw, source);
  const name = localPath(target, kind === 'page');
  return name ? publicUrl(name, kind === 'page', parsed, from) : raw;
}
// CSS URLs can contain parentheses, e.g. IRANSansWeb(FaNum).woff2.
function cssUrlSpans(css) {
  const spans = [];
  for (const match of css.matchAll(/url\s*\(/gi)) {
    let position = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    for (; position < css.length; position++) {
      const char = css[position];
      if (quote) {
        if (char === '\\') { position++; continue; }
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth++;
      else if (char === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const raw = css.slice(match.index + match[0].length, position).trim();
    const value = /^["']/.test(raw) && raw.at(-1) === raw[0] ? raw.slice(1, -1) : raw;
    spans.push({ start: match.index, end: position + 1, value, quote: raw[0] === '"' || raw[0] === "'" ? raw[0] : '' });
  }
  return spans;
}
function cssUrls(css) { return cssUrlSpans(css).map(span => span.value); }
function rewriteCss(css, source, from) {
  const spans = cssUrlSpans(css);
  for (const span of spans.reverse()) {
    css = css.slice(0, span.start) + `url(${span.quote}${rewriteOne(span.value, source, 'asset', from)}${span.quote})` + css.slice(span.end);
  }
  return css;
}
const pageAttrs = /\b(href|src|poster|data-src|data-lazy-src|action)\s*=\s*(["'])(.*?)\2/gi;
function rewriteHtml(html, source, from) {
  let result = html.replace(pageAttrs, (_, attr, quote, value) => {
    const lower = attr.toLowerCase();
    // Forms need a backend. Keep their original destination for the audit.
    if (lower === 'action') return `${attr}=${quote}${value}${quote}`;
    let kind = 'asset';
    try { if (lower === 'href' && !assetExt.test(new URL(value, source).pathname)) kind = 'page'; } catch { /* keep asset */ }
    return `${attr}=${quote}${rewriteOne(value, source, kind, from)}${quote}`;
  });
  result = result.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (_, quote, value) =>
    `srcset=${quote}${value.split(',').map(part => {
      const [url, ...descriptor] = part.trim().split(/\s+/);
      return [rewriteOne(url, source, 'asset', from), ...descriptor].join(' ');
    }).join(', ')}${quote}`);
  result = result.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (_, quote, value) =>
    `style=${quote}${rewriteCss(value, source, from)}${quote}`);
  result = result.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_, attrs, css) => `<style${attrs}>${rewriteCss(css, source, from)}</style>`);
  // WordPress pagination is a real page here, so the Woodmart "load more" button has to
  // become an ordinary link; its JavaScript otherwise calls the missing admin-ajax.php.
  result = result.replace(/<a\b([^>]*\bclass=["'][^"']*\bwd-load-more\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi,
    (match, attrs) => {
      const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(match)?.[2] ?? '';
      const next = normalize(href, source);
      const target = next && localPath(next, true) ? rewriteOne(next, source, 'page', from) : null;
      let nextAttrs = attrs.replace(/\bclass\s*=\s*(["'])(.*?)\1/i,
        (_, quote, value) => `class=${quote}${value.replace(/\b(?:load-on-click|load-on-scroll|wd-portfolio-load-more|wd-blog-load-more|wd-shop-load-more)\b/g, 'kixmax-load-more').trim()}${quote}`);
      nextAttrs = nextAttrs.replace(/\s*rel=["'][^"']*["']/i, '');
      if (target) nextAttrs = nextAttrs.replace(/\bhref\s*=\s*(["'])(.*?)\1/i, `href="${target}"`);
      return `<a${nextAttrs}>${match.slice(match.indexOf('>') + 1)}`;
    });
  // Elementor and Woodmart keep same-host URLs inside JSON attributes and inline scripts,
  // escaped as https:\/\/host\/path. Rewrite those too so nothing points at the origin.
  result = result.replace(/https?:\\\/\\\/[^"'&<>\s]+/gi, match => rewriteEscaped(match, source, from));
  result = result.replace(/(?<![\w.-])https?:\/\/[^"'<>)\s]+/gi, match => rewriteAbsolute(match, source, from));
  result = result.replace(/(?<![\w./-])\/\/kixmax\.co\/[^"'<>)\s]*/gi, match => rewriteAbsolute(`https:${match}`, source, from));
  return result;
}
function trimUrlTail(url) {
  let text = url;
  let trailing = '';
  while (text.length > 1 && /[.,;:!?)\]}\\/]/.test(text.at(-1))) { trailing = text.at(-1) + trailing; text = text.slice(0, -1); }
  return [text, trailing];
}
function rewriteEscaped(match, source, from) {
  const [text, trailing] = trimUrlTail(match);
  // JSON escapes have to be decoded before the URL is parsed. The WHATWG URL parser
  // treats a backslash as a path separator for http(s), so a \uXXXX escape (Elementor
  // writes Persian upload filenames that way) would be read as /uXXXX and the asset
  // reference destroyed. Decode to real characters, rewrite, then re-escape.
  const plain = decodeJsonEscapes(text);
  const local = rewriteAbsolute(plain, source, from);
  if (local === plain) return match;
  return /["'<>]/.test(local) ? match : `${encodeJsonEscapes(local)}${trailing}`;
}
function decodeJsonEscapes(text) {
  return text
    .replaceAll('\\/', '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
function encodeJsonEscapes(text) {
  return text
    .replaceAll('/', '\\/')
    .replace(/[^\x20-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function rewriteAbsolute(match, source, from) {
  const [text, trailing] = trimUrlTail(match);
  let parsed;
  try { parsed = new URL(text); } catch { return match; }
  if (parsed.host !== base.host) return match;
  const isPage = !parsed.search && !assetExt.test(parsed.pathname);
  const name = localPath(parsed.href, isPage);
  if (!name) return match;
  return `${publicUrl(name, isPage, parsed, from, false)}${trailing}`;
}

// The manifest is written after the page phase and again at the end, so a run that dies in
// the long asset phase still leaves a resumable report behind.
async function writeReport() {
  await save('mirror-report.json', JSON.stringify({
    source: base.href,
    createdAt: new Date().toISOString(),
    media,
    pages: [...pages].map(([url, file]) => ({ url, file })),
    assets: [...assets].map(([url, data]) => ({ url, ...data })),
    failures,
    forms,
    externalResources: [...externalResources],
    missingAttachments,
    discoveredPages: pageQueue.length,
    maxPages
  }, null, 2));
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  if (!refresh) {
    try {
      const previous = JSON.parse(await fs.readFile(path.join(output, 'mirror-report.json'), 'utf8'));
      if (previous.source === base.href) {
        for (const record of previous.pages || []) {
          enqueuePage(record.url);
          if (await savedFileExists(record.file)) pages.set(record.url, record.file);
        }
        for (const record of previous.assets || []) {
          enqueueAsset(record.url);
          // Re-fetch CSS once to repair URLs parsed incorrectly by earlier versions.
          if (!record.type?.includes('text/css') && !record.file?.endsWith('.css') &&
            await savedFileExists(record.file)) assets.set(record.url, record);
        }
        for (const record of previous.failures || []) {
          if (record.type === 'page') enqueueLink(record.url);
          else enqueueAsset(record.url);
        }
        forms.push(...(previous.forms || []));
        for (const resource of previous.externalResources || []) externalResources.add(resource);
        console.log(`Resuming: ${pages.size} saved pages, ${assets.size} saved assets.`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not load previous report: ${error.message}`);
    }
  }
  try {
    const listReport = JSON.parse(await fs.readFile(path.join(output, 'static-list-report.json'), 'utf8'));
    for (const value of listReport.missingPages || []) {
      const page = normalize(value);
      if (page) enqueuePage(page);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not load list report: ${error.message}`);
  }
  for (const route of ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml', '/sitemap-index.xml']) {
    await discoverSitemap(urlOf(route));
  }
  // discoverRest() fires ~20 rapid wp-json fetches which trigger a short-lived Cloudflare
  // IP block. The sitemap already provides all pages for this site, so skip it by default.
  if (process.env.MIRROR_REST === '1') await discoverRest();
  console.log(`Discovered ${pageQueue.length} candidate pages before rendering.`);
  // Brief pause after the sitemap fetch phase so Cloudflare doesn't carry over any
  // rate-limit signal into the Chrome session that follows immediately.
  await new Promise(done => setTimeout(done, 5000));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    protocolTimeout: 180000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      // kixmax.co sits behind Cloudflare, which advertises HTTP/3. Headless Chrome in a
      // container often fails the QUIC handshake, so force HTTP/1.1 and TCP.
      '--disable-quic', '--disable-http3', '--disable-features=UseDnsHttpsSvcb,HttpDns',
      // Cloudflare bot-detection checks for the AutomationControlled blink feature.
      '--disable-blink-features=AutomationControlled'
    ]
  });
  try {
    const tab = await browser.newPage();
    await tab.evaluateOnNewDocument(() => {
      // Cloudflare inspects navigator.webdriver; undefining it makes the page look like a real browser.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await tab.setUserAgent(userAgent);
    await tab.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await tab.setViewport({ width: 1440, height: 1000 });
    tab.on('response', response => {
      const task = captureResponse(response);
      responseTasks.add(task);
      task.finally(() => responseTasks.delete(task));
    });
    for (let index = 0; index < pageQueue.length && index < maxPages; index++) {
      const url = pageQueue[index];
      if (pages.has(url)) { console.log(`CACHED PAGE ${index + 1}/${pageQueue.length} ${url}`); continue; }
      // Cooldown every 8 rendered pages to avoid Cloudflare's WAF rate-limit threshold.
      const rendered = pages.size;
      if (rendered > 0 && rendered % 8 === 0) {
        console.log(`COOLDOWN after ${rendered} pages (45s)...`);
        await new Promise(done => setTimeout(done, 45000));
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        let response = null;
        try {
          response = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        } catch (error) {
          // Some kixmax.co pages sit behind a stalled third-party script and never fire
          // DOMContentLoaded in time. The document is usually already usable, so keep the
          // page rather than dropping it; only a real protocol error is fatal.
          if (!/timeout/i.test(error.message)) throw error;
          // Check for off-host redirect here too: tab.url() at timeout time may still show
          // the original kixmax.co URL even when the browser already followed the redirect,
          // so we'd fall through to tab.evaluate() on a destroyed context.
          try {
            const timedLanded = tab.url();
            if (/^https?:$/.test(new URL(timedLanded).protocol) && new URL(timedLanded).host !== base.host) {
              const name = localPath(url, true);
              const target = timedLanded.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
              if (name) { pages.set(url, name); await save(name, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><link rel="canonical" href="${target}"><title>Redirecting</title><a href="${target}">${target}</a>\n`); }
              console.log(`REDIRECT ${index + 1}/${pageQueue.length} ${url} -> ${timedLanded}`);
              continue;
            }
          } catch { /* tab.url() can throw during navigation; treat as normal timeout */ }
          console.warn(`TIMEOUT ${url}: saving the partially loaded document`);
        }
        if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
        // Some permalinks (the QR landing pages) 301 to Instagram. Mirror the redirect, not
        // the third-party page the browser followed it to.
        let landed; try { landed = tab.url(); } catch { landed = url; }
        if (/^https?:$/.test(new URL(landed).protocol) && new URL(landed).host !== base.host) {
          const name = localPath(url, true);
          const target = landed.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
          if (name) {
            pages.set(url, name);
            await save(name, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><link rel="canonical" href="${target}"><title>Redirecting</title><a href="${target}">${target}</a>\n`);
          }
          console.log(`REDIRECT ${index + 1}/${pageQueue.length} ${url} -> ${landed}`);
          continue;
        }
        // WordPress marks images loading="lazy"; scrolling is what makes them request.
        // Every wait is bounded so one stalled asset cannot hang the whole capture.
        await tab.evaluate(async () => {
          const pause = ms => new Promise(done => setTimeout(done, ms));
          const limit = ms => new Promise(done => setTimeout(done, ms));
          const height = () => Math.max(document.body.scrollHeight, 1);
          for (let y = 0; y < height(); y += Math.max(window.innerHeight * 0.8, 200)) {
            window.scrollTo(0, y);
            await pause(150);
          }
          window.scrollTo(0, 0);
          await pause(300);
          await Promise.race([
            Promise.all([...document.images].filter(img => !img.complete).map(img => new Promise(done => {
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
            }))),
            limit(15000)
          ]);
          await pause(300);
        });
        const found = await tab.evaluate(() => ({
          links: [...document.querySelectorAll('a[href], area[href], iframe[src]')].map(el => el.href || el.src),
          assets: [
            ...performance.getEntriesByType('resource').map(entry => entry.name),
            ...[...document.querySelectorAll('link[href], script[src], img[src], img[srcset], img[data-src], img[data-lazy-src], source[src], source[srcset], video[src], video[poster], audio[src], embed[src], object[data]')]
              .flatMap(el => [
                el.href, el.src, el.poster, el.data,
                el.getAttribute('data-src'), el.getAttribute('data-lazy-src'),
                ...(el.srcset || el.getAttribute('data-srcset') || '').split(',').map(part => part.trim().split(/\s+/)[0])
              ])
          ].filter(Boolean),
          styles: [...document.querySelectorAll('[style], style')].map(el => el.getAttribute('style') || el.textContent || ''),
          forms: [...document.forms].map(el => ({ action: el.action, method: el.method, name: el.name || null, fields: [...new FormData(el).keys()].filter(key => !key.startsWith('_')) }))
        }));
        for (const value of found.links) enqueueLink(value, url);
        for (const value of found.assets) {
          const local = normalize(value, url);
          if (local) enqueueAsset(local);
          else if (/^https?:/i.test(value)) externalResources.add(value);
        }
        for (const form of found.forms) forms.push({ page: url, ...form });
        for (const css of found.styles) for (const child of cssUrls(css)) enqueueAsset(urlOf(child, url));
        const html = await tab.content();
        const name = localPath(url, true);
        if (name) { pages.set(url, name); await save(name, rewriteHtml(html, url, name)); }
        console.log(`PAGE ${index + 1}/${pageQueue.length} ${url}`);
        // Brief pause between pages to avoid Cloudflare rate-limiting.
        await new Promise(done => setTimeout(done, 800));
        break; // success — exit retry loop
      } catch (error) {
        if (attempt < 2 && /ERR_CONNECTION_RESET/i.test(error.message)) {
          console.warn(`RETRY ${url} after connection reset (30s cooldown)...`);
          await new Promise(done => setTimeout(done, 30000));
          continue;
        }
        failures.push({ type: 'page', url, error: error.message });
        console.warn(`FAILED PAGE ${url}: ${error.message}`);
      }
      } // end retry loop
    }
    await Promise.all(responseTasks);
  } finally { await browser.close(); }
  // Checkpoint the manifest here. The asset phase is the long one, and a manifest written
  // only at the end means an interrupted run cannot be resumed.
  await writeReport();
  const queue = [...assetQueue].filter(url => !assets.has(url));
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const response = await get(url);
        const type = response.headers.get('content-type') || '';
        if (type.includes('text/html')) { enqueuePage(url); continue; }
        const name = localPath(url);
        if (!name) continue;
        let body = Buffer.from(await response.arrayBuffer());
        if (type.includes('text/css') || name.endsWith('.css')) {
          const css = body.toString('utf8');
          for (const child of cssUrls(css)) enqueueAsset(urlOf(child, url));
          body = Buffer.from(rewriteCss(css, url, name));
        }
        await save(name, body);
        assets.set(url, { file: name, bytes: body.length, type });
        if (++done % 25 === 0) console.log(`ASSET ${assets.size}/${assetQueue.size}`);
      } catch (error) {
        failures.push({ type: 'asset', url, error: error.message });
        console.warn(`FAILED ASSET ${url}: ${error.message}`);
      }
    }
  }));
  await writeReport();
  console.log(`Done: ${pages.size} pages, ${assets.size} assets, ${failures.length} failures.`);
  if (!pages.size || failures.length || pageQueue.length > maxPages) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
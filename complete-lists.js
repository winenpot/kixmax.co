import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

// A WordPress mirror is only trustworthy if every same-host reference in the captured HTML
// resolves to a file on disk. This pass walks the saved pages in a browser (so real DOM
// parsing, not regex guessing), reports what is missing, and writes the result to
// static-list-report.json. The next `pnpm mirror` reads that report and fetches the gaps.
const siteDir = path.resolve(process.env.MIRROR_OUTPUT || 'kixmax-site');
const origin = new URL(process.env.MIRROR_URL || 'https://kixmax.co/');
const concurrency = Math.max(1, Number(process.env.MIRROR_CONCURRENCY || 4));

// Must stay in step with ignoredPath/ignoredQuery in scrape.js.
const ignoredPath = /\/(?:wp-admin|wp-login\.php|wp-cron\.php|wp-signup\.php|wp-trackback\.php|wp-mail\.php|wp-activate\.php|wp-comments-post\.php|xmlrpc\.php|wp-json|feed)(?:\/|\.|$)/i;
const ignoredQuery = /[?&](?:s|replytocom|share|add-to-cart|remove-from-cart|rest_route|add-to-wishlist|cms_block|p|page_id)=/i;
function isIgnored(url) {
  const parsed = new URL(url);
  return ignoredPath.test(parsed.pathname) || ignoredQuery.test(parsed.search);
}
// Must stay in step with localPath() in scrape.js.
function localName(url, page = false) {
  const parsed = new URL(url, origin);
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { pathname = parsed.pathname; }
  if (page) {
    if (pathname.endsWith('/')) pathname += 'index.html';
    else if (!path.posix.extname(pathname)) pathname += '/index.html';
  } else if (pathname.endsWith('/')) return null;
  if (parsed.search) {
    const ext = path.posix.extname(pathname);
    // scrape.js uses a sha256 prefix; the audit only needs a stable per-URL name, so
    // resolve the ?ver= style variants through the mirror report instead of guessing.
    return { variant: true, key: `${pathname}${parsed.search}` };
  }
  return path.posix.normalize(pathname).replace(/^\/+/, '');
}
async function* htmlFiles(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const name = path.join(folder, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(name);
    else if (entry.name.endsWith('.html')) yield name;
  }
}

const mirror = await fs.readFile(path.join(siteDir, 'mirror-report.json'), 'utf8')
  .then(text => JSON.parse(text))
  .catch(() => ({ assets: [], pages: [] }));
// Every asset the mirror saved, keyed by both plain and ?query forms, so a reference with a
// cache-busting query string counts as present when the file exists.
const saved = new Set();
for (const record of [...mirror.assets, ...mirror.pages]) {
  if (record.url) saved.add(new URL(record.url).pathname);
  if (record.file) saved.add('/' + record.file);
}
const missingPages = new Set();
const missingAssets = new Set();
const externalHosts = new Map();
let checked = 0;

async function audit(tab, file) {
  const html = await fs.readFile(file, 'utf8');
  // Redirect stubs contain <meta http-equiv="refresh"> and trigger a navigation before
  // evaluate() can run. Skip them — they have no same-host links to audit.
  if (/<meta\s[^>]*http-equiv=["']?refresh["']?/i.test(html)) { checked++; return; }
  const page = '/' + path.relative(siteDir, file).split(path.sep).join('/');
  // The address the page was captured from, so relative links resolve like in a browser.
  const source = new URL(`https://kixmax.co${page.replace(/index\.html$/, '')}`, origin).href;
  await tab.setContent(html, { waitUntil: 'domcontentloaded' });
  const found = await tab.evaluate(pageUrl => {
    const base = new URL(pageUrl);
    const out = { links: [], assets: [], external: [] };
    const push = (list, value) => {
      if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return;
      let absolute;
      try { absolute = new URL(value, base).href; } catch { return; }
      if (!/^https?:/i.test(absolute)) return;
      list.push(absolute);
    };
    for (const node of document.querySelectorAll('a[href], area[href], link[href], script[src], img[src], img[srcset], source[src], source[srcset], video[src], video[poster], iframe[src], embed[src], object[data]')) {
      const isPage = ['A', 'AREA', 'IFRAME'].includes(node.tagName);
      const target = isPage ? out.links : out.assets;
      push(target, node.getAttribute('href'));
      push(target, node.getAttribute('src'));
      push(target, node.getAttribute('poster'));
      push(target, node.getAttribute('data'));
      for (const attribute of ['srcset', 'data-srcset']) {
        const value = node.getAttribute(attribute);
        if (!value) continue;
        for (const part of value.split(',')) push(target, part.trim().split(/\s+/)[0]);
      }
    }
    // Inline styles and <style> blocks carry the same-host background and font URLs.
    for (const node of document.querySelectorAll('[style], style')) {
      const css = node.tagName === 'STYLE' ? node.textContent : node.getAttribute('style');
      for (const match of (css || '').matchAll(/url\(([^)]*)\)/g)) {
        push(out.assets, match[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
    return out;
  }, source);
  for (const url of found.external) externalHosts.set(new URL(url).host, (externalHosts.get(new URL(url).host) || 0) + 1);
  const record = (url, isPage) => {
    const parsed = new URL(url);
    if (parsed.host !== origin.host) {
      externalHosts.set(parsed.host, (externalHosts.get(parsed.host) || 0) + 1);
      return;
    }
    if (isIgnored(url)) return;
    const name = localName(url, isPage);
    if (typeof name === 'object') {
      if (!saved.has(new URL(url).pathname) && ![...saved].some(entry => entry.startsWith(new URL(url).pathname))) return;
      return;
    }
    if (!name) return;
    if (!saved.has('/' + name)) (isPage ? missingPages : missingAssets).add(url);
  };
  for (const url of found.links) record(url, true);
  for (const url of found.assets) record(url, false);
  checked++;
}

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-quic', '--disable-http3']
});
try {
  const queue = [];
  for await (const file of htmlFiles(siteDir)) queue.push(file);
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    const tab = await browser.newPage();
    // Local markup only: a captured page must not reach the live site while we audit it.
    await tab.setRequestInterception(true);
    tab.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '' }));
    while (queue.length) await audit(tab, queue.shift());
    await tab.close();
  });
  await Promise.all(workers);
} finally { await browser.close(); }

const report = {
  createdAt: new Date().toISOString(),
  checkedPages: checked,
  missingPages: [...missingPages],
  missingAssets: [...missingAssets],
  externalHosts: [...externalHosts].sort((a, b) => b[1] - a[1]).map(([host, count]) => ({ host, count }))
};
await fs.writeFile(path.join(siteDir, 'static-list-report.json'), JSON.stringify(report, null, 2));
console.log(`Checked ${checked} pages: ${missingPages.size} missing pages, ${missingAssets.size} missing assets.`);
for (const { host, count } of report.externalHosts) console.log(`  external ${host} (${count})`);
if (missingPages.size || missingAssets.size) process.exitCode = 1;

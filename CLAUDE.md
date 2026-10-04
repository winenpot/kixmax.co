# kixmax.co mirror -- working notes

Static mirror of the WordPress site at `https://kixmax.co/`, served by `server.js`
(Node built-ins only: `node:http`, `node:sqlite`, `node:zlib`). No reverse proxy,
no runtime dependencies.

Verify with `pnpm run check` (syntax-checks all four scripts).

## Why this repo exists

The WordPress install is unrecoverable -- no credentials, no contact with the
original developers. The domain is ours and the site still answers, so capturing
the public front end is the only asset recovery available. Same play as `atpg.co`
and `filfilworld.com`, both already done successfully.

This means: **the capture is the deliverable.** Treat `kixmax-site/` as precious. If
the origin dies before a good capture exists, nothing in this repo can recover it.

## Layout

- `scrape.js` -- Puppeteer crawler. Renders each page in Chrome, scrolls to
  trigger lazy loading, saves same-host assets, rewrites URLs to document-relative.
- `server.js` -- the whole web server. Serves the capture, injects the client
  script, handles `/api/forms`, `/api/submissions`, `/search/`, `/health`.
- `server-client.js` -- injected into every served page. Neutralises Turnstile,
  takes over Elementor form submission, points WP search at the mirror's search.
- `complete-lists.js` -- audits saved pages in a browser, writes
  `kixmax-site/static-list-report.json` listing same-host pages/assets still missing.
- `kixmax-site/` -- the capture. Gitignored (large, re-creatable from the live site
  while it lasts).

## Capture and verify

```sh
pnpm install
pnpm mirror && pnpm mirror:lists && pnpm mirror
```

Discovery for this site: Rank Math `/sitemap_index.xml` (200) including `product-sitemap.xml`.
Expected scope: 52 sitemap URLs (35 products).

**Exit code 0 does not mean the capture is good.** Both of these have happened
before and both are silent:

1. **Corrupt asset bodies.** The scraper writes whatever it receives without
   validating. An `.mp4` was once saved as 18 KB of high-entropy garbage (no
   `ftyp` box at offset 4) while the live file was 2.5 MB; the browser reported
   `DEMUXER_ERROR_COULD_NOT_OPEN`. Check magic bytes, and compare the largest
   assets against the live `Content-Length` -- a truncated-but-valid file passes
   a magic-byte check.

2. **Mangled non-ASCII references.** Elementor writes non-ASCII upload filenames
   as JSON `\uXXXX` escapes inside `data-settings`. The WHATWG `new URL()` parser
   treats a backslash as a path separator for http(s), so `\u0648` was parsed as
   `/u0648`, destroying the reference while the file on disk stayed fine. Fixed in
   `scrape.js` via `decodeJsonEscapes()` before parsing and `encodeJsonEscapes()`
   after. Rank Math's JSON-LD image refs break the same way.
   Guard: `grep -rlo '/u06[0-9a-f][0-9a-f]' kixmax-site/` must print nothing.

   ASCII-named assets are immune, so a site can look fine on its English-named
   files while every non-ASCII one is broken. Check both.

**Diagnose media in a browser, not from the HTML.** Read `video.error.code` and
`readyState` over CDP. Accessibility snapshots report "Unable to play media" for
both genuinely broken videos and perfectly fine ones, so that string proves
nothing.

## Always cache-bust when verifying

`server.js` sends `cache-control: public, max-age=3600`. After any deploy or file
repair, a plain reload serves the OLD asset and looks like the fix failed. This
caused two false "still broken" diagnoses on `atpg.co`. Append `?cb=<timestamp>`
when testing, and tell the user to hard-reload.

## Deploy, and the staleness trap

`Dockerfile.app` does `COPY kixmax-site/ ./kixmax-site/` and `compose.yml` mounts only
`data:`. The capture is baked into the image, so editing `kixmax-site/` on the host --
or rsyncing it -- does NOT change what a running container serves. With
`pull_policy: never` plus an existing image, `docker compose up -d` reuses the old
build.

```sh
docker compose up -d --build     # --build is required after re-capturing
```

Verify inside the container, not on the host, and prefer comparing served bytes
(`md5sum` of a `curl`) over trusting the deploy output.

## Conventions

- Env prefix is `MIRROR_` (shared across the mirror repos, unlike `atpg.co`'s
  `ATPG_`). CSS/status-class prefix for this site is `kixmax-`.
- Port 8092 is this site's published host port. Internal is always 8080.
- One commit per logical change; never bundle unrelated concerns.
- Keep `data/` (SQLite submissions) and `kixmax-site/` out of git.
- Do not commit `.env`.

## Site-specific notes

- **WooCommerce with 35 products.** Cart, checkout, My Account and wishlist render but do nothing -- they require PHP and a database. Never describe them as working.
- Largest capture: expect the longest crawl and most media of the three.

## What a mirror can never do

WordPress PHP, the database, logins, cart/checkout, Turnstile (domain-bound site
key), and third-party embeds. `admin-ajax.php` answers `{}` because that is what
the captured Elementor scripts expect. Be explicit about this with stakeholders
rather than letting a rendered-but-dead button imply it works.

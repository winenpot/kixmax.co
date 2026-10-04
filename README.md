# kixmax.co mirror

Static mirror of `https://kixmax.co/` with working Elementor form submissions and
search, served by a single Node.js process.

**Why this exists.** The WordPress install behind `kixmax.co` is effectively
unrecoverable: no credentials, no contact with whoever built it. The domain is
still ours and the site still answers, so the public front end is the one asset
that can be taken back -- by capturing it before it goes away. This is the same
play already run successfully for `atpg.co` and `filfilworld.com`.

**A mirror is a snapshot.** It cannot recover the WordPress database, plugin
configuration, drafts, private pages, user accounts, or the hosting account. It
captures what a visitor can see, and nothing more.

Live stack observed at capture time: WordPress 7.1.2, Elementor, PHP 8.3.35.

## Capture it first

The site is live today; that is not guaranteed next month. Capture before
anything else, and keep the result.

```sh
pnpm install
pnpm mirror          # capture into kixmax-site/
pnpm mirror:lists    # audit for pages/assets the crawl missed
pnpm mirror          # fetch the gaps the audit found
```

Discovery for this site: Rank Math sitemap index at `/sitemap_index.xml` (200), including `product-sitemap.xml`.

Expected scope: 52 sitemap URLs: 35 products, 11 pages, 5 posts, 1 category.

A nonzero exit status means the capture is incomplete. Reruns resume from
`kixmax-site/mirror-report.json`, so an interrupted crawl is safe to restart.

```sh
MIRROR_URL=https://kixmax.co/ MIRROR_OUTPUT=kixmax-site MIRROR_MAX_PAGES=2000 MIRROR_TIMEOUT_MS=60000 pnpm mirror
MIRROR_MEDIA=all MIRROR_ATTACHMENTS=1 pnpm mirror   # full media library (much larger)
MIRROR_REFRESH=1 pnpm mirror                        # re-crawl everything from scratch
MIRROR_CONCURRENCY=6 pnpm mirror
```

## Verify the capture -- do not trust exit code 0

Two failure modes have bitten this toolchain before on `atpg.co`, both silent.
Check for them every time:

1. **Corrupt asset bodies.** A video was once saved as 18 KB of garbage with no
   `ftyp` box while the live file was 2.5 MB. The scraper does not validate what
   it writes.

   ```sh
   # every mp4 must have 'ftyp' at byte offset 4
   find kixmax-site -name '*.mp4' -exec sh -c 'printf "%s " "$1"; dd if="$1" bs=1 skip=4 count=4 2>/dev/null; echo' _ {} \;
   # a truncated-but-valid file passes a magic-byte test, so also compare sizes
   # against the live Content-Length for the largest assets
   ```

2. **Mangled non-ASCII asset references.** Elementor writes non-ASCII upload
   filenames as JSON `\uXXXX` escapes. A URL-rewriting bug turned `\u0648` into
   `/u0648`, breaking four pages while the files on disk were perfectly fine.
   Fixed in `scrape.js`, but re-check after any change there:

   ```sh
   grep -rlo '/u06[0-9a-f][0-9a-f]' kixmax-site/ | head   # must print nothing
   ```

Then look at it in a browser, not just at HTTP status codes.

## Run it

```sh
pnpm start           # http://localhost:8080
```

`pnpm mirror` is only needed to build or refresh `kixmax-site/`. To serve, you need
`server.js`, `server-client.js`, and a captured `kixmax-site/`.

Captured HTML uses document-relative asset paths, so pages also open from disk
over `file://` -- but the injected client script only runs over `http://`, so
form handling and search need the server.

## Deploy

```sh
cp .env.example .env            # set MIRROR_ADMIN_TOKEN if you want the read API
docker compose up -d --build
```

Compose publishes `127.0.0.1:8092` by default, so nothing is exposed to the
internet until TLS is in front of it. Override `MIRROR_BIND` and `MIRROR_PORT`
in `.env`.

**`--build` is not optional.** `Dockerfile.app` bakes `kixmax-site/` into the image
and `pull_policy: never` reuses an existing image, so a plain
`docker compose up -d` after re-capturing serves the OLD content. Confirm what
the container actually has, rather than trusting the deploy:

```sh
docker compose exec mirror sh -c 'ls -l /app/kixmax-site/index.html'
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port inside the container |
| `HOST` | `0.0.0.0` | Listen address |
| `MIRROR_SITE_DIR` | `kixmax-site` | Captured mirror to serve |
| `MIRROR_DATA_DIR` | `data` | SQLite directory for submissions |
| `MIRROR_ADMIN_TOKEN` | unset | Required by `GET /api/submissions`. Unset closes the read API |
| `MIRROR_TRUST_PROXY` | `0` | Set to `1` only when a proxy in front sets `X-Forwarded-For` |

`GET /health` returns `ok` and backs the container healthcheck. `SIGTERM` drains
in-flight requests and closes SQLite, so `docker compose stop` and rolling
restarts do not lose submissions.

### TLS

There is no certificate handling here. Terminate TLS in front of the process --
a cloud load balancer, or Caddy/Traefik on the same host forwarding to
`127.0.0.1:8092`. If you add one, set `MIRROR_TRUST_PROXY=1` so the form rate
limiter sees real client addresses.

### Backups

Submissions live in the `data` volume (`mirror.sqlite`, WAL mode). Back up
`data/`; back up `kixmax-site/` only if you may not be able to re-capture -- which,
for a site in this state, is the likely case. Keep `data/` out of source control.

## Forms

Elementor posts to `admin-ajax.php`, which does not exist here.
`server-client.js` is injected into every served page, intercepts the submit
button before Elementor's own handler, and posts the fields to `/api/forms`. The
server stores them in SQLite and returns the success message the form displays.
Original fields, layout and validation are preserved; only the transport changes.

```sh
curl -H "Authorization: Bearer ***" http://localhost:8092/api/submissions
```

Submissions are rate-limited to 5 per minute per address. Add moderation and
spam controls before inviting public traffic: the original Cloudflare Turnstile
cannot be reused, because its site key is bound to the original domain.

## Search

`/search/?q=term` and `/?s=term`. The index is built from the saved HTML at
startup, so search needs no database and no reindexing.

## What the mirror cannot do

- **WordPress PHP.** `admin-ajax.php` answers `{}`, which is what the captured
  Elementor scripts expect.
- **Cloudflare Turnstile.** Site key is domain-bound; the injected client removes
  the widget and submits directly.
- **Third-party embeds.** Social platforms, fonts and maps are recorded as
  external and never crawled. Outbound links still point at them.
- **Analytics.** Tag Manager / Analytics beacons are stripped when a page is
  served, so this deployment does not report traffic to the old property.

## Site-specific notes

- **WooCommerce, 35 products.** Cart, checkout, My Account and wishlist will render but cannot work on a static mirror: they need PHP and a database. Treat them as decorative and say so to stakeholders.
- Largest capture of the three; expect the longest crawl and the most media.

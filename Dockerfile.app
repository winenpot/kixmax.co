# Production image for the kixmax.co mirror.
#
# server.js is the entire web server: it serves the captured mirror, handles compression,
# conditional requests and byte ranges itself, and stores form submissions in SQLite.
# There is no reverse proxy in this stack and no runtime dependency to install, because
# the server only uses Node built-ins (node:http, node:sqlite, node:zlib).
FROM node:26-alpine

WORKDIR /app

COPY server.js server-client.js ./
# The capture is baked into the image. Rebuild with --build after re-mirroring,
# or bind-mount kixmax-site/ in compose.yml during development.
COPY kixmax-site/ ./kixmax-site/

# The submission database is the only writable path, so it is also the only volume.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV MIRROR_SITE_DIR=/app/kixmax-site
ENV MIRROR_DATA_DIR=/app/data

USER node
EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

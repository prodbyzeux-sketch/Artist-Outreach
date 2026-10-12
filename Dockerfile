# The official Playwright image: Chromium plus every system dependency it
# needs. The version MUST match "playwright" in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=3456 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DATA_DIR=/tmp/ao-data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts
# The browser extension: the server packs it, patched for PUBLIC_URL, into
# /downloads/artist-outreach-extension.zip (tests are left out by .dockerignore).
COPY extension ./extension

# The unprivileged user the image ships with.
USER pwuser
EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]

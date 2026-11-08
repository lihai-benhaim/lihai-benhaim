# Content Studio: one container, runs on any NAS with Docker (Synology, QNAP, Unraid, TrueNAS).
# Debian trixie ships ffmpeg 7 built with fribidi/harfbuzz, needed for right-to-left Hebrew text.
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

WORKDIR /app

# Dependencies first, so code changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/publishers/package.json packages/publishers/
COPY packages/media/package.json packages/media/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod

COPY packages packages
COPY apps apps

ENV NODE_ENV=production \
    DATA_DIR=/data \
    FONT_FILE=/usr/share/fonts/truetype/noto/NotoSansHebrew-Bold.ttf \
    PORT=8080

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node 22 runs the TypeScript sources directly (type stripping); no build step.
CMD ["node", "apps/server/src/main.ts"]

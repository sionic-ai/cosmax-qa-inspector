# syntax=docker/dockerfile:1

# Shared-service convention: verify in the image build, then ship only runtime files.
FROM node:22-alpine AS verify
WORKDIR /app

COPY package.json package-lock.json ./
COPY server.mjs ./
COPY public ./public
COPY test ./test
RUN npm run check && npm test

FROM node:22-alpine AS runtime
LABEL maintainer="eng@sionic.ai"
LABEL org.opencontainers.image.title="COSMAX VLM QA Inspector"
LABEL org.opencontainers.image.description="Cosmetic packaging inspection demo"

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRUST_PROXY_HOSTS=1

RUN addgroup -S nodejs && adduser -S inspector -G nodejs
COPY --from=verify --chown=inspector:nodejs /app/package.json ./package.json
COPY --from=verify --chown=inspector:nodejs /app/server.mjs ./server.mjs
COPY --from=verify --chown=inspector:nodejs /app/public ./public

USER inspector
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/_health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

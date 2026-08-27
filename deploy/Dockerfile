ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    SIMMER_HOST=0.0.0.0 \
    SIMMER_PORT=8788

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
COPY --from=dependencies /app/server/node_modules ./node_modules

COPY server/ ./
COPY index.html /app/index.html
COPY css/ /app/css/
COPY js/ /app/js/

VOLUME ["/app/server/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/api/range').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "index.js"]

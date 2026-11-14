# Built by GitHub Actions and pulled by the server, which never compiles; see design §16.
FROM node:26-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.11.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/build build
COPY package.json ./
# Migrations run at start-up, read from here.
COPY db/migrations db/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# A crawler's request can carry a 50 MB file.
CMD ["node", "--max-old-space-size=256", "build/server/index.js"]

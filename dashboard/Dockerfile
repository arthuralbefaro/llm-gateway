# built from the repository root because the dashboard is a pnpm workspace
# member and the lockfile lives there
FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/package.json
RUN pnpm install --frozen-lockfile --filter llm-gateway-dashboard

COPY dashboard dashboard
RUN pnpm --filter llm-gateway-dashboard build


FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002

# next standalone bundles its own node_modules subset and server entrypoint
COPY --from=build /repo/dashboard/.next/standalone ./
COPY --from=build /repo/dashboard/.next/static dashboard/.next/static

EXPOSE 3002

CMD ["node", "dashboard/server.js"]

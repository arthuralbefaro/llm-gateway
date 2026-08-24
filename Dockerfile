# build has the toolchain, prisma cli and the compiled seed, and is also the
# image the migrate service runs, runtime carries only production dependencies,
# the compiled app and the baked model
FROM node:24-slim AS build
WORKDIR /app
ENV CI=true

RUN corepack enable

# manifests first so dependency layers survive source edits
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/package.json
RUN pnpm install --frozen-lockfile

COPY prisma prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src src

# the generated client is gitignored, a fresh checkout has to produce it
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm prisma generate
RUN pnpm build

# the seed stays runnable without ts-node by compiling it once here
RUN npx tsc prisma/seed.ts --outDir seed-dist --module commonjs \
    --esModuleInterop --target ES2022 --skipLibCheck

COPY ops/docker/download-model.mjs ops/docker/download-model.mjs
RUN node ops/docker/download-model.mjs


# separate stage so the migrate service can target build with the prisma cli
# still present, pruning inside build would remove the tool migrate exists for
FROM build AS pruned
RUN pnpm prune --prod


FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=pruned /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/.models .models
COPY --from=build /app/package.json package.json

EXPOSE 3000

# node instead of curl because the slim image ships neither curl nor wget
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main"]

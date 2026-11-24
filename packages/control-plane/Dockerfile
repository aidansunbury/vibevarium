# Terrarium control plane — node 22, pnpm workspace, tsx.
# Build context MUST be the monorepo root (compose sets context: ../../).
# NOTE: the control-plane GUI is served from Cloudflare at platform.<domain>,
# NOT this image — only the app template's SPA is built here (for the scaffold).

# ── Stage 1b: build the app template's SPA (shipped into generated apps by the
# scaffold's materialize step). Its web/dist is gitignored, so it never reaches
# the runtime image from source — it must be built here.
FROM node:22-slim AS templatewebbuild
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app
COPY packages/template-cloudflare/web/ packages/template-cloudflare/web/
COPY packages/ui/ packages/ui/
RUN cd packages/template-cloudflare/web \
  && pnpm install --ignore-workspace \
  && pnpm run build

# ── Stage 2: the control plane runtime
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
RUN npm install -g tsx@4

WORKDIR /app

# Copy workspace root manifests + npmrc
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./

# Copy all package manifests (pnpm needs them for workspace resolution)
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/template/package.json packages/template/
COPY packages/auth/package.json packages/auth/
COPY packages/dev-issuer/package.json packages/dev-issuer/
COPY packages/fake-oauth/package.json packages/fake-oauth/
COPY packages/cli/package.json packages/cli/
COPY packages/template-cloudflare/package.json packages/template-cloudflare/
COPY packages/connections/package.json packages/connections/

# Install all workspace deps (control-plane has heavy transitive deps)
RUN pnpm install --frozen-lockfile

# Copy all source (control-plane imports from sibling packages)
COPY packages/ packages/

# The app template's pre-built SPA — the scaffold's materialize ships it into
# every generated app (the Worker's assets.directory serves it).
COPY --from=templatewebbuild /app/packages/template-cloudflare/web/dist packages/template-cloudflare/web/dist

WORKDIR /app/packages/control-plane

ENV NODE_ENV=production
EXPOSE 4100

CMD ["tsx", "src/main.ts"]

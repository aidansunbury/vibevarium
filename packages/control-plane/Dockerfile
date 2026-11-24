# Terrarium control plane — node 22, pnpm workspace, tsx.
# Build context MUST be the monorepo root (compose sets context: ../../).
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

# Build the control-plane web GUI into packages/control-plane/web/dist. The web
# sub-package has its own lockfile (nested standalone install), so install it
# with --ignore-workspace, then build. The server serves GUI_DIR=web/dist.
RUN cd packages/control-plane/web \
  && pnpm install --ignore-workspace \
  && pnpm run build

WORKDIR /app/packages/control-plane

ENV NODE_ENV=production
EXPOSE 4100

CMD ["tsx", "src/main.ts"]

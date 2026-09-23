# Production image for the @roam/api service (Railway).
#
# WHY A DOCKERFILE: Railway's Nixpacks/Railpack builders auto-invoke pnpm through a
# bundled corepack that cannot launch pnpm 11 (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING),
# and they ignore the custom build command override. A Dockerfile takes the auto-builder
# out of the loop entirely: we control the Node version, install pnpm directly via npm
# (no corepack), run the frozen install, and start the API. Fully deterministic, committed.
#
# The API runs TypeScript source directly via tsx (no compile step), consistent with how
# the whole monorepo runs. We install the full workspace so @roam/api's workspace deps
# (@roam/core, @roam/db) resolve, then start only the api service.

FROM node:22-slim

# pnpm, installed directly — bypasses Railway's broken bundled corepack.
# Pinned to match packageManager + the lockfile exactly (no resolution drift).
RUN npm install -g pnpm@11.5.1

WORKDIR /app

# Copy the whole monorepo (workspace resolution needs all package.json + the lockfile).
COPY . .

# Frozen install: reproducible, matches the committed pnpm-lock.yaml exactly.
RUN pnpm install --frozen-lockfile

# MUST come after the install, never before. pnpm treats NODE_ENV=production as --prod and omits
# devDependencies — and tsx, which IS this service's runtime (see the CMD below), is a
# devDependency. Set above the install line, the image would build and then fail to start.
#
# Set here it does what it should: libraries that branch on NODE_ENV take their production path.
# The API's own tRPC config no longer depends on this being right (packages/api/src/trpc.ts pins
# isDev explicitly) — this is the second layer, not the only one.
ENV NODE_ENV=production

# Railway injects $PORT at runtime; main.ts reads it and fail-fasts if absent.
# Start only the API service from the workspace root.
CMD ["pnpm", "--filter", "@roam/api", "start"]

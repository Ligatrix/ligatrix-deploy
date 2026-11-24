# syntax=docker/dockerfile:1
#
# Reference service image. Build from the repository root:
#   docker build -f docker/Dockerfile -t reference-app:1.0.0 .
#
# Pin the base by digest in production (node:22-alpine@sha256:...) and let a
# dependency bot raise the pin; the tag alone is kept here for readability.
ARG NODE_IMAGE=node:22-alpine

# ---- build: assemble only what runs, and fail fast on syntax errors ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY app/package.json ./package.json
COPY app/src ./src
# No install step: the service has no dependencies. With dependencies, copy the
# lockfile here and run `npm ci --omit=dev --ignore-scripts` in this stage only.
RUN find src -name '*.js' -exec node --check {} \;

# ---- runtime: no package managers, no build tools, no write access to code ---
FROM ${NODE_IMAGE} AS runtime
# npm and yarn are not needed to run a service; removing them shrinks the image
# and the number of binaries an attacker could use.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# Code stays owned by root: the process can read it but never rewrite it.
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/src ./src
# The image's built-in unprivileged user (uid 1000).
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.js"]
STOPSIGNAL SIGTERM
# Exec form: node is PID 1 and receives SIGTERM directly; the service installs
# its own handlers. Compose adds `init: true` for zombie reaping.
CMD ["node", "src/main.js"]

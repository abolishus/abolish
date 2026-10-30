# The intake relay's image: Node and the bundle in dist/ (vite.config.ts,
# pack), nothing else of the repo. Build it after
# `vp run --filter @abolishus/intake-relay... build`, with this directory as
# the context (.dockerignore lets only dist/ in). Same base and rules as
# apps/trustee-node/Dockerfile.
#
# It takes its whole configuration from `RELAY_CONFIG` (README,
# Configuration) and listens where that names, in plain HTTP behind the
# host's TLS edge; it keeps no state, so it needs no volume.
FROM mirror.gcr.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --chown=0:0 --chmod=a=rX dist/ /app/

ENV NODE_ENV=production
USER node
WORKDIR /app
CMD ["node", "main.mjs"]

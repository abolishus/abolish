# The worker's image: Node and the bundle in dist/ (vite.config.ts, pack),
# nothing else of the repo. Build it after
# `vp run --filter @abolishus/worker... build`, with this directory as the
# context (.dockerignore lets only dist/ in). Same base and rules as
# apps/api/Dockerfile.
#
# One image, three services: what a worker runs is decided by its variables
# alone (README, Running). The creation worker gets the creation step's and
# nothing else, and refuses to start beside any other job's; the setup worker
# gets everything else but the posting worker's, which runs as
# `node posting.mjs` with its own variables and nothing else
# (docs/runbooks/railway.md, Services; docs/runbooks/posting-relay.md).
FROM mirror.gcr.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --chown=0:0 --chmod=a=rX dist/ /app/

# No port: the worker serves nothing, it only reaches Postgres, Dragonfly and
# the chains' nodes.
ENV NODE_ENV=production
USER node
WORKDIR /app
# `node creation-key.mjs status` (or `sweep <funding address>`) runs the
# creation key's commands instead (docs/runbooks/poll-creation.md).
CMD ["node", "main.mjs"]

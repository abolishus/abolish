# A trustee seat's image: Node and the bundle in dist/ (vite.config.ts, pack),
# nothing else of the repo. Build it after
# `vp run --filter @abolishus/trustee-node... build`, with this directory as
# the context (.dockerignore lets only dist/ in). Same base and rules as
# apps/api/Dockerfile.
#
# The default command is `run-env` over the volume at /data, for a host that
# gives the seat its configuration and identity key as variables
# (docs/runbooks/trustee-node.md, Staging on Railway). No /data is made here:
# a seat started without its volume refuses to run rather than starting from
# an empty store. A trustee on their own host runs `node main.mjs run
# --config <file>` instead.
FROM mirror.gcr.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --chown=0:0 --chmod=a=rX dist/ /app/

# No port: the seat only reaches out to its coordinator over HTTPS. A
# configuration with `intake` or `availability` listens where it names.
ENV NODE_ENV=production
USER node
WORKDIR /app
CMD ["node", "main.mjs", "run-env", "--data", "/data"]

# The API image: Node and the bundle in dist/, nothing else of the repo
# (vite.config.ts, pack). Build it after `vp run --filter @abolishus/api... build`,
# with this directory as the context (.dockerignore lets only dist/ in).
#
# No `# syntax=` line: an external frontend would be one more image pulled by
# tag at build time; the builder's own frontend parses this file.
# Reproducible: the base is pinned by digest (Google's mirror of the Docker
# Hub library image, same digest, pulled without credentials and without the
# rate limits ECR Public and Docker Hub put on runners' shared addresses; T-65),
# and the build sets SOURCE_DATE_EPOCH and rewrite-timestamp, so two builds of
# one commit give one digest (docs/runbooks/railway.md, Building; T-61).
FROM mirror.gcr.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# The image runs a bundle and never installs anything: drop the package
# managers so a compromised process finds no installer to fetch code with (T-55).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Root-owned and read-only to the process: it can't rewrite its own code or
# the migrations the image was built with.
COPY --chown=0:0 --chmod=a=rX dist/ /app/

# Every IPv4 interface: the container's network is the boundary, and the
# proxy in front terminates TLS. A service reached over Railway's private
# network over IPv6 sets API_HOST=:: instead; a host without IPv6 would
# refuse that as a default.
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=8787
EXPOSE 8787
USER node
WORKDIR /app
# `node migrate.mjs` runs the migrations instead (docs/runbooks/railway.md).
CMD ["node", "main.mjs"]

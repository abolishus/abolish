# The website's image: Node and the bundle in dist/ (node/main.mjs, server/,
# client/), nothing else of the repo. Build it after
# `vp run --filter @abolishus/web... build`, with this directory as the context
# (.dockerignore lets only dist/ in). Same base and rules as apps/api/Dockerfile.
FROM public.ecr.aws/docker/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --chown=0:0 --chmod=a=rX dist/ /app/

# Every IPv4 interface: Railway's proxy in front terminates TLS.
ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3000
EXPOSE 3000
USER node
WORKDIR /app
CMD ["node", "node/main.mjs"]

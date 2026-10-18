# The challenge page's staging image: Node, the static page in dist/ and the
# dependency-free server in server/, nothing else of the repo. Build it after
# `vp run --filter @abolishus/challenge... build`, with this directory as the
# context (.dockerignore lets only dist/ and server/ in). Same base and rules as
# apps/api/Dockerfile. A release pins its own challenge origin next to the
# entry points (docs/spec/registration.md, Challenge page); this image is for
# staging.
FROM mirror.gcr.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --chown=0:0 --chmod=a=rX dist/ /app/dist/
COPY --chown=0:0 --chmod=a=rX server/ /app/server/

# Every IPv4 interface: Railway's proxy in front terminates TLS.
ENV NODE_ENV=production \
    CHALLENGE_HOST=0.0.0.0 \
    CHALLENGE_PORT=8080
EXPOSE 8080
USER node
WORKDIR /app
CMD ["node", "server/serve.mjs"]

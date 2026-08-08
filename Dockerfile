FROM oven/bun:1-alpine AS client-build

WORKDIR /client
# The lockfile is copied with the manifest so the install is reproducible and
# stays cached until one of the two actually changes.
COPY ./client/package.json ./client/bun.lock ./
RUN bun install --frozen-lockfile
COPY ./client ./
RUN bun run build

FROM oven/bun:1-alpine AS server-build

WORKDIR /myspeed

COPY ./package.json ./bun.lock /myspeed/
RUN bun install --production --frozen-lockfile

COPY ./server /myspeed/server
COPY ./scripts /myspeed/scripts
RUN bun run generate-migrations
RUN bun run generate-integrations

FROM oven/bun:1-alpine

# ca-certificates for TLS to the speedtest providers, tzdata so the configured
# TZ resolves - both are needed at runtime. apk --no-cache leaves no index behind,
# so there is nothing to purge afterwards.
# su-exec drops privileges in the entrypoint, which is what lets the container
# start as root just long enough to take ownership of an upgraded volume.
RUN apk add --no-cache tzdata ca-certificates su-exec

ENV TZ=Etc/UTC

# Express reports full stack traces to the client for any unhandled route error
# unless this is set, and the health endpoint is deliberately unauthenticated.
ENV NODE_ENV=production

WORKDIR /myspeed

COPY --from=server-build /myspeed/server /myspeed/server
COPY --from=server-build /myspeed/package.json /myspeed/package.json
COPY --from=server-build /myspeed/node_modules /myspeed/node_modules
COPY --from=client-build /client/build /myspeed/build

# The image ran as root, so a compromise of the server - which spawns
# third-party speedtest binaries it downloads at runtime - owned the container.
# `bun` is the unprivileged user the base image already provides.
#
# bin/ is created and owned here because the CLIs are downloaded into it on
# first boot, and it deliberately sits outside the data volume so an upgrade
# refetches binaries matching the new image.
RUN mkdir -p /myspeed/data /myspeed/bin && chown -R bun:bun /myspeed

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# No USER here on purpose: the entrypoint starts as root, takes ownership of a
# volume an older image left behind, and then drops to `bun` itself. Setting
# USER instead would leave every existing install unable to write to its own
# data directory after an upgrade.
ENTRYPOINT ["docker-entrypoint.sh"]

VOLUME ["/myspeed/data"]

EXPOSE 5216

# The start period is generous because the first boot downloads the three
# provider CLIs before the server begins listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${SERVER_PORT:-5216}/api/health" || exit 1

CMD ["bun", "run", "server/index.js"]

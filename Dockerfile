# 1.3.14, the same Bun the release binaries are compiled with, and for the same
# reason: the official Alpine image installs Bun's x64-musl-baseline asset for
# x86_64, and from 1.4.0 that asset is byte-identical to the AVX2 build - so
# the container crashed at start on a pre-AVX2 host with no fallback at all,
# and verify-image.sh could not tell, because the runners it boots the image on
# have AVX2. tests/server/windowsBaseline.test.js holds all three stages to the
# binaries' pin; move both together, once the two x64 zips differ again.
FROM oven/bun:1.3.14-alpine AS client-build

WORKDIR /client
# The lockfile is copied with the manifest so the install is reproducible and
# stays cached until one of the two actually changes.
COPY ./client/package.json ./client/bun.lock ./
RUN bun install --frozen-lockfile
COPY ./client ./
RUN bun run build

# Every cfspeedtest release is glibc-linked, so the binary the server downloads
# on first boot cannot exec on this musl base - the kernel reports the missing
# interpreter as ENOENT on the binary itself, and the Cloudflare provider then
# records a failed test every run with nothing naming the cause. The crate is
# published, so the same version is compiled against musl here and shipped in
# bin/, where fileExists() finds it and the download is skipped.
FROM rust:1.98.0-alpine AS cfspeedtest-build

# Bumped by hand. Nothing watches it: dependabot's docker ecosystem reads FROM
# tags, and there is no Cargo.toml here for its cargo ecosystem to find - so
# this pin is only as current as the last person to look at it. It is the
# binary the container runs for every Cloudflare test.
ARG CFSPEEDTEST_VERSION=2.2.2

# musl-dev only: cfspeedtest reaches the network through rustls, so nothing in
# the tree probes pkg-config for a system library.
RUN apk add --no-cache musl-dev
RUN cargo install cfspeedtest --locked --version ${CFSPEEDTEST_VERSION} --root /out

FROM oven/bun:1.3.14-alpine AS server-build

WORKDIR /myspeed

COPY ./package.json ./bun.lock /myspeed/
RUN bun install --production --frozen-lockfile

COPY ./server /myspeed/server
COPY ./scripts /myspeed/scripts
RUN bun run generate-migrations
RUN bun run generate-integrations

FROM oven/bun:1.3.14-alpine

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
#
# data/ is created here for a second reason, and at a stated mode. VOLUME takes
# the mode and the ownership of whatever stands at the path when the image is
# built, so this line is what the volume comes out as - and under the build's 022
# umask that was 0755. storage.db holds the admin password hash and every
# integration secret and is written 0644 inside it, data/certs holds the TLS
# private key, and the server downloads and spawns third-party binaries, so
# "readable by every account in the container" is not an empty set.
#
# server/util/createFolders.js states the same 700, and cannot reach it here: it
# decides the mode of a directory it creates, and this one exists before the
# server has ever started. Split off bin, which is a downloaded executable rather
# than a secret and keeps the umask's mode - the same split the helper's own list
# makes. chown after chmod, and it preserves the mode.
RUN mkdir -p /myspeed/bin \
    && mkdir -p /myspeed/data && chmod 700 /myspeed/data \
    && chown -R bun:bun /myspeed

COPY --from=cfspeedtest-build --chown=bun:bun /out/bin/cfspeedtest /myspeed/bin/cfspeedtest

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# No USER here on purpose: the entrypoint starts as root, takes ownership of a
# volume an older image left behind, and then drops to `bun` itself. Setting
# USER instead would leave every existing install unable to write to its own
# data directory after an upgrade.
ENTRYPOINT ["docker-entrypoint.sh"]

VOLUME ["/myspeed/data"]

EXPOSE 5216

# The start period is generous because the first boot downloads the Ookla and
# librespeed CLIs before the server begins listening. The Cloudflare one is
# baked in above, so it is the one provider that costs nothing here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${SERVER_PORT:-5216}/api/health" || exit 1

CMD ["bun", "run", "server/index.js"]

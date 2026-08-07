FROM oven/bun:1-alpine AS client-build

WORKDIR /client
COPY ./client/package.json ./
RUN bun install
COPY ./client ./
RUN bun run build

FROM oven/bun:1-alpine AS server-build

WORKDIR /myspeed

COPY ./server /myspeed/server
COPY ./scripts /myspeed/scripts
COPY ./package.json /myspeed/package.json

RUN bun install --production
RUN bun run generate-migrations
RUN bun run generate-integrations

FROM oven/bun:1-alpine

# ca-certificates for TLS to the speedtest providers, tzdata so the configured
# TZ resolves - both are needed at runtime. apk --no-cache leaves no index behind,
# so there is nothing to purge afterwards.
RUN apk add --no-cache tzdata ca-certificates

ENV TZ=Etc/UTC

WORKDIR /myspeed

COPY --from=server-build /myspeed/server /myspeed/server
COPY --from=server-build /myspeed/package.json /myspeed/package.json
COPY --from=server-build /myspeed/node_modules /myspeed/node_modules
COPY --from=client-build /client/build /myspeed/build

VOLUME ["/myspeed/data"]

EXPOSE 5216

CMD ["bun", "run", "server/index.js"]

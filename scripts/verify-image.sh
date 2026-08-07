#!/usr/bin/env bash
#
# Smoke-tests a built MySpeed image before it is published.
#
# Boots the image, waits for the health endpoint, then confirms that the api and
# the bundled client are actually served and that the container's own healthcheck
# agrees. Exits non-zero - after dumping the container log - if any of that fails,
# so a broken image never reaches the registry.
#
# Usage: scripts/verify-image.sh <image> [port]
set -euo pipefail

IMAGE="${1:?usage: verify-image.sh <image> [port]}"
PORT="${2:-5216}"
CONTAINER="myspeed-verify-$$"
BASE="http://127.0.0.1:${PORT}"

# The first boot downloads the three provider CLIs before the server listens.
# Overridable so the wait can be tightened on a fast network or in a test.
MAX_ATTEMPTS="${VERIFY_MAX_ATTEMPTS:-60}"
SLEEP_SECONDS="${VERIFY_SLEEP_SECONDS:-5}"

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
    echo "::error::$1"
    echo "--- container log (last 50 lines) ---"
    docker logs "$CONTAINER" 2>&1 | tail -50 || true
    exit 1
}

echo "Starting $IMAGE as $CONTAINER on port $PORT ..."
docker run -d --name "$CONTAINER" -p "${PORT}:5216" "$IMAGE" >/dev/null

echo "Waiting for ${BASE}/api/health ..."
healthy=0
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if curl -fsS --max-time 5 "${BASE}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
        echo "  healthy after ~$(( attempt * SLEEP_SECONDS ))s"
        healthy=1
        break
    fi

    if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
        fail "The container exited before becoming healthy."
    fi

    sleep "$SLEEP_SECONDS"
done

[ "$healthy" -eq 1 ] || fail "The image never reported healthy; refusing to publish it."

# Health only proves the process is up and the database opened; make sure the
# things users actually consume are served as well.
echo "Checking the api ..."
curl -fsS --max-time 10 "${BASE}/api/speedtests/status" | grep -q '"running"' \
    || fail "The api did not answer as expected."

echo "Checking the bundled client ..."
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE}/")" = "200" ] \
    || fail "The bundled client was not served."

echo "Checking the container healthcheck ..."
[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER")" = "healthy" ] \
    || fail "The container's own healthcheck did not report healthy."

echo "Image verified."

#!/usr/bin/env bash
# Verifies an image entirely inside its own network-none container. No host
# ports are published and every HTTP request is made by the shared checker to
# the child process's literal loopback listener.
set -euo pipefail

IMAGE="${1:?usage: verify-image.sh <image> [internal-port]}"
PORT="${2:-5216}"
PREFIX="myspeed-verify"
RANDOM_BYTES=16
EXPECTED_HEX_LENGTH=$((RANDOM_BYTES * 2))
RUN_ID="$(LC_ALL=C od -An -N"$RANDOM_BYTES" -tx1 /dev/urandom | tr -d ' \n')"
[ "${#RUN_ID}" -eq "$EXPECTED_HEX_LENGTH" ] || {
    echo "::error::Could not create a cryptographically random verification ID."
    exit 1
}
CONTAINER="${PREFIX}-${RUN_ID}"
DATA_VOLUME="${CONTAINER}-data"
BIN_VOLUME="${CONTAINER}-bin"
DOCKER="${DOCKER_CLI:-docker}"
OWNERSHIP_LABEL="org.myspeed.qualification.run"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUALIFICATION_DIR="${SCRIPT_DIR}/qualification"
COLLECTOR="${QUALIFICATION_DIR}/collect-summary.mjs"
EVIDENCE_ROOT="${QUALIFICATION_EVIDENCE_DIRECTORY:-${RUNNER_TEMP:-${PWD}}/myspeed-image-evidence-${RUN_ID}}"
MAX_ATTEMPTS="${VERIFY_MAX_ATTEMPTS:-900}"
SLEEP_SECONDS="${VERIFY_SLEEP_SECONDS:-0.1}"
CFSPEEDTEST_VERSION="2.2.2"
status="starting"
saw_healthy=0
container_created=0
data_volume_created=0
bin_volume_created=0
SOURCE_ARGUMENTS=()
if [ -n "${QUALIFICATION_SOURCE_SHA:-}" ]; then
    SOURCE_ARGUMENTS=(--source-sha "$QUALIFICATION_SOURCE_SHA")
fi

if [ -e "$EVIDENCE_ROOT" ] && { [ ! -d "$EVIDENCE_ROOT" ] || [ -n "$(ls -A "$EVIDENCE_ROOT")" ]; }; then
    echo "::error::Refusing nonempty qualification evidence directory: $EVIDENCE_ROOT"
    exit 1
fi
mkdir -p "$EVIDENCE_ROOT"
EVIDENCE_MOUNT_DIR="$EVIDENCE_ROOT"
# Git Bash otherwise rewrites container paths (including /myspeed/data) into
# Windows paths. Convert just the host sources, then forward Docker arguments.
case "$(uname -s)" in
    MINGW*|MSYS*)
        QUALIFICATION_DIR="$(cygpath -m "$QUALIFICATION_DIR")"
        EVIDENCE_MOUNT_DIR="$(cygpath -m "$EVIDENCE_ROOT")"
        COLLECTOR="$(cygpath -m "$COLLECTOR")"
        export MSYS2_ARG_CONV_EXCL='*'
        ;;
esac
"$DOCKER" image inspect "$IMAGE" > "$EVIDENCE_ROOT/image-inspect.json"

container_exists() {
    "$DOCKER" inspect "$CONTAINER" >/dev/null 2>&1
}

volume_exists() {
    "$DOCKER" volume inspect "$1" >/dev/null 2>&1
}

container_is_owned() {
    [ "$("$DOCKER" inspect --format "{{ index .Config.Labels \"${OWNERSHIP_LABEL}\" }}" "$CONTAINER" 2>/dev/null || true)" = "$RUN_ID" ]
}

volume_is_owned() {
    [ "$("$DOCKER" volume inspect --format "{{ index .Labels \"${OWNERSHIP_LABEL}\" }}" "$1" 2>/dev/null || true)" = "$RUN_ID" ]
}

cleanup() {
    original_status=$?
    cleanup_failed=0
    trap - EXIT

    if [ "$container_created" -eq 1 ]; then
        if container_exists; then
            if container_is_owned; then
                "$DOCKER" logs "$CONTAINER" > "$EVIDENCE_ROOT/container.log" 2>&1 || true
                "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || cleanup_failed=1
            else
                cleanup_failed=1
            fi
        fi
    fi
    if [ "$data_volume_created" -eq 1 ]; then
        if volume_exists "$DATA_VOLUME"; then
            if volume_is_owned "$DATA_VOLUME"; then
                "$DOCKER" volume rm "$DATA_VOLUME" >/dev/null 2>&1 || cleanup_failed=1
            else
                cleanup_failed=1
            fi
        fi
    fi
    if [ "$bin_volume_created" -eq 1 ]; then
        if volume_exists "$BIN_VOLUME"; then
            if volume_is_owned "$BIN_VOLUME"; then
                "$DOCKER" volume rm "$BIN_VOLUME" >/dev/null 2>&1 || cleanup_failed=1
            else
                cleanup_failed=1
            fi
        fi
    fi

    if [ "$cleanup_failed" -ne 0 ]; then
        echo "::error::Could not remove every task-owned verification container or volume."
        exit 1
    fi
    exit "$original_status"
}
trap cleanup EXIT

fail() {
    echo "::error::$1"
    if [ "$container_created" -eq 1 ] && container_is_owned; then
        echo "--- container log (last 50 lines) ---"
        "$DOCKER" logs "$CONTAINER" 2>&1 | tail -50 || true
    fi
    exit 1
}

if container_exists; then
    fail "Docker container $CONTAINER already exists; refusing to reuse it."
fi
if volume_exists "$DATA_VOLUME"; then
    fail "Docker volume $DATA_VOLUME already exists; refusing to reuse it."
fi
if volume_exists "$BIN_VOLUME"; then
    fail "Docker volume $BIN_VOLUME already exists; refusing to reuse it."
fi

if ! "$DOCKER" volume create --label "${OWNERSHIP_LABEL}=${RUN_ID}" "$DATA_VOLUME" >/dev/null; then
    if volume_is_owned "$DATA_VOLUME"; then
        data_volume_created=1
    fi
    fail "Could not create task-owned Docker volume $DATA_VOLUME."
fi
volume_is_owned "$DATA_VOLUME" || fail "Docker did not preserve the ownership label on $DATA_VOLUME."
data_volume_created=1
if ! "$DOCKER" volume create --label "${OWNERSHIP_LABEL}=${RUN_ID}" "$BIN_VOLUME" >/dev/null; then
    if volume_is_owned "$BIN_VOLUME"; then
        bin_volume_created=1
    fi
    fail "Could not create task-owned Docker volume $BIN_VOLUME."
fi
volume_is_owned "$BIN_VOLUME" || fail "Docker did not preserve the ownership label on $BIN_VOLUME."
bin_volume_created=1

# Prove fresh volumes are empty from the Docker daemon's filesystem, before
# the image's normal volume copy-up supplies its baked provider executable.
if ! "$DOCKER" run \
    --name "$CONTAINER" \
    --label "${OWNERSHIP_LABEL}=${RUN_ID}" \
    --network none \
    --mount "type=volume,source=${DATA_VOLUME},target=/myspeed/data,volume-nocopy" \
    --mount "type=volume,source=${BIN_VOLUME},target=/myspeed/bin,volume-nocopy" \
    --entrypoint bun "$IMAGE" -e \
    'const fs = require("fs"); for (const directory of ["/myspeed/data", "/myspeed/bin"]) { if (fs.readdirSync(directory).length !== 0) throw new Error("Refusing nonempty qualification volume: " + directory); } console.log("Both task-owned volumes are empty");' \
    > "$EVIDENCE_ROOT/volume-preflight.log" 2>&1; then
    if container_is_owned; then container_created=1; fi
    fail "Fresh volume preflight failed."
fi
container_is_owned || fail "Volume preflight container ownership could not be proved."
container_created=1
"$DOCKER" rm "$CONTAINER" >/dev/null || fail "Could not remove the completed volume preflight container."
container_created=0

echo "Starting isolated verification container $CONTAINER ..."
if ! "$DOCKER" run -d \
    --name "$CONTAINER" \
    --label "${OWNERSHIP_LABEL}=${RUN_ID}" \
    --network none \
    --cap-add SYS_PTRACE \
    --env SERVER_PORT="$PORT" \
    --health-interval 1s \
    --health-timeout 2s \
    --health-start-period 1s \
    --health-retries 10 \
    --mount "type=volume,source=${DATA_VOLUME},target=/myspeed/data" \
    --mount "type=volume,source=${BIN_VOLUME},target=/myspeed/bin" \
    --mount "type=bind,source=${QUALIFICATION_DIR},target=/qualification,readonly" \
    --mount "type=bind,source=${EVIDENCE_MOUNT_DIR},target=/evidence" \
    --entrypoint bun \
    "$IMAGE" \
    /qualification/check-artifact.mjs \
    --command /usr/local/bin/docker-entrypoint.sh \
    --artifact /usr/local/bin/bun \
    --repo /myspeed \
    "${SOURCE_ARGUMENTS[@]}" \
    --work /myspeed \
    --keep-work \
    --expected-uid 1000 \
    --expected-cfspeedtest-version "$CFSPEEDTEST_VERSION" \
    --port "$PORT" \
    --evidence-dir /evidence \
    --healthcheck-handshake /evidence \
    --arg bun \
    --arg run \
    --arg /myspeed/server/index.js >/dev/null; then
    if container_is_owned; then
        container_created=1
    fi
    fail "Could not start task-owned verification container $CONTAINER."
fi
container_is_owned || fail "Docker did not preserve the ownership label on $CONTAINER."
container_created=1
"$DOCKER" inspect "$CONTAINER" > "$EVIDENCE_ROOT/container-inspect.json"

[ "$("$DOCKER" inspect --format '{{.HostConfig.NetworkMode}}' "$CONTAINER")" = "none" ] \
    || fail "The verifier container is not in Docker's network-none mode."
[ -z "$("$DOCKER" port "$CONTAINER")" ] \
    || fail "The verifier container unexpectedly publishes a host port."

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    status="$("$DOCKER" inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)"
    if [ "$status" != "starting" ] && [ "$status" = "healthy" ]; then
        saw_healthy=1
        if [ -f "$EVIDENCE_ROOT/healthcheck-request.json" ] && [ ! -e "$EVIDENCE_ROOT/healthcheck-ack.json" ]; then
            # Same-directory rename makes the acknowledgement visible whole.
            # Never overwrite an acknowledgement from another request/run.
            ack_temp="$(mktemp "$EVIDENCE_ROOT/healthcheck-ack.XXXXXX")"
            cp "$EVIDENCE_ROOT/healthcheck-request.json" "$ack_temp"
            mv -n "$ack_temp" "$EVIDENCE_ROOT/healthcheck-ack.json"
        fi
    fi

    running="$("$DOCKER" inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
    [ "$running" != "true" ] && break
    sleep "$SLEEP_SECONDS"
done

[ "$saw_healthy" -eq 1 ] \
    || fail "The image's own healthcheck never reported healthy (last status: ${status:-none})."

exit_code="$("$DOCKER" inspect --format '{{.State.ExitCode}}' "$CONTAINER")"
[ "$exit_code" = "0" ] \
    || fail "The isolated artifact verifier exited with code $exit_code."

node "$COLLECTOR" \
    --evidence-dir "$EVIDENCE_MOUNT_DIR" --output "$EVIDENCE_MOUNT_DIR/qualification-summary.json" \
    --mode full "${SOURCE_ARGUMENTS[@]}"

echo "Image verified. Evidence: $EVIDENCE_ROOT"

#!/bin/sh
set -e

# The server runs as the unprivileged `bun` user, but a data volume created by
# an older image belongs to root - so an upgrade would land on a volume the
# server cannot write, and fail at the first database open. Taking ownership
# here keeps the upgrade a plain `docker pull` instead of a manual chown, and
# costs nothing on a fresh install.
#
# Only when started as root. Anyone running with --user gets straight through,
# which is what makes a read-only or hardened deployment still work.
#
# -h, because chown resolves a symlink it is handed unless told not to. The
# server writes this volume as `bun`, so a symlink planted under it - the first
# thing to look at after any compromise of that process, and `data/x ->
# /etc/shadow` is the shape of it - is followed on the next restart, and the file
# at the far end is handed to the very account the server runs as. Changing the
# link itself is the only thing in the volume that ever needed changing.
if [ "$(id -u)" = "0" ]; then
    chown -Rh bun:bun /myspeed/data /myspeed/bin 2>/dev/null || \
        echo "Warning: could not take ownership of /myspeed/data; the server may not be able to write to it"

    exec su-exec bun "$@"
fi

exec "$@"

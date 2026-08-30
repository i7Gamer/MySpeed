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

    # And the mode, for the volumes this image is not the one that created.
    #
    # A VOLUME comes out at the mode of the directory standing at that path in
    # the image that declared it, and `docker pull` replaces the image while
    # leaving the volume - so a data directory initialised before the Dockerfile
    # stated 700 keeps its 0755 through every upgrade there will ever be, with
    # storage.db 0644 inside it. The server's own folder helper cannot repair it
    # either: it decides the mode of a directory it creates, and this one is
    # always already there.
    #
    # o-rwx rather than 700, on the terms install.sh states at the same decision.
    # A host directory bind-mounted here has group bits an operator chose -
    # shared with a backup account, say - and a container that rewrote them on
    # every restart would overrule that silently and for ever.
    #
    # The world bits come off all the same, and that is a trade rather than a
    # free win: an operator can mean the 0755 on a bind mount as deliberately as
    # they mean the 0750, and this closes it on every start without asking. It is
    # taken because what sits in that directory is the admin password hash, the
    # integration secrets and the TLS private key, so "readable by every account
    # on the host" is the one intent worth being wrong about.
    #
    # Idempotent, so a volume already at 700 costs one syscall a start. Guarded
    # like the chown above: a read-only mount must not take the container down
    # under `set -e` over a mode it was never going to be allowed to change.
    chmod o-rwx /myspeed/data 2>/dev/null || \
        echo "Warning: could not tighten /myspeed/data; it may be readable by other accounts in this container"

    exec su-exec bun "$@"
fi

# The same attempt for the deployments that never reach the block above.
#
# --user is what the gate exists to let through, and a rootless container over a
# named volume an older image initialised carries exactly the 0755 the line above
# was written to repair. So does every bind mount, which no image initialises at
# all, whichever account starts the container. Inside the gate, this reached
# neither of them: the comment above claimed to be the only moment anything was
# placed to notice, and for those two deployments nothing was.
#
# It reaches what this process is allowed to reach, which is the honest whole of
# it. A volume or bind mount the account owns is tightened; a root-owned one is
# not, and nothing available here can change that. Those installs still need a
# `chmod o-rwx` on the host, or one start as root.
#
# Silent, where the root path warns. Root failing to chmod a directory it owns is
# a fact worth a line. Rootless failing is the ordinary, correct case - the
# volume belongs to root and this container is deliberately not root - so a
# warning would print on every start of every hardened deployment, which is how a
# warning stops being read at all. `|| true` for the reason the guard above has
# one: `set -e` would otherwise end the container over a mode it was never going
# to be allowed to change, before the server it exists to start has run.
chmod o-rwx /myspeed/data 2>/dev/null || true

exec "$@"

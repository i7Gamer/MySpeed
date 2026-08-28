import fs from 'node:fs';
import path from 'node:path';

const baseDir = process.cwd();

// The mode data/ and everything under it is created with, rather than whatever
// the umask leaves behind. storage.db holds the admin password hash and every
// integration secret, and data/certs holds the TLS private key; both are written
// inside these directories under the process umask - 0644 inside a 0755
// directory - so at the default mode any local account on the host can read
// them.
//
// What this file is the only thing covering, now that both installers state the
// mode themselves: a bare checkout or a plain `bun start`, which runs neither of
// them; `bin` on install.sh's root fallback, the one branch of it that does not
// create that directory; and data/logs, data/servers and data/certs everywhere,
// which nothing outside this file has ever made. install.sh creates data on
// every branch it takes, and the Dockerfile creates /myspeed/data at 700 before
// VOLUME takes that mode - so the container, which this comment used to name as
// its own, belongs to the image and docker-entrypoint.sh.
//
// Creation only, deliberately, and that is this file's whole share of a policy
// the three of them state together. A data directory made here is made at 700.
// One that is already there keeps the mode its operator gave it: install.sh and
// the entrypoint take the world bits off it and nothing else, so an older
// installer's 0755 is closed while a directory deliberately shared with a backup
// group at 0750 stays shared. A data directory that is a symlink is left alone
// entirely, because the operator moved it there on purpose. This decides how a
// directory is made, not what an existing installation is allowed to look like:
// the two of them run as root, at the moment the operator is installing or
// starting the thing, which is where a correction to a directory already on disk
// belongs. This runs as the server, which may not own what it would be
// rewriting - and would be rewriting it on every boot.
//
// Ignored by node on win32, which is right rather than a gap - Windows has no
// POSIX mode bits and the ACL inherited from the parent is what governs there.
const PRIVATE_MODE = 0o700;

// bin is the only one that stays at the umask's mode: it holds the speedtest CLI
// MySpeed downloads, which is an executable it fetches rather than a secret it
// writes.
const neededFolder = [
    {name: "data", mode: PRIVATE_MODE},
    {name: "bin"},
    {name: "data/logs", mode: PRIVATE_MODE},
    {name: "data/servers", mode: PRIVATE_MODE},
    {name: "data/certs", mode: PRIVATE_MODE}
];

neededFolder.forEach(({name: folder, mode}) => {
    const fullPath = path.join(baseDir, folder);
    if (!fs.existsSync(fullPath)) {
        try {
            fs.mkdirSync(fullPath, {recursive: true, mode});
        } catch (e) {
            // Exits non-zero: reporting success while the server has nowhere to
            // write meant a container that could not start looked, to Docker
            // and to the operator, as though it had stopped cleanly.
            console.error(`Could not create the ${folder} folder: ${e.message}`);
            console.error("Check that the data directory is writable by the user the server runs as.");
            process.exit(1);
        }
    }
});
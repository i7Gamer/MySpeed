import fs from 'node:fs';
import path from 'node:path';

const baseDir = process.cwd();

// The mode data/ and everything under it is created with, rather than whatever
// the umask leaves behind. storage.db holds the admin password hash and every
// integration secret, and data/certs holds the TLS private key; both are written
// inside these directories under the process umask - 0644 inside a 0755
// directory - so at the default mode any local account on the host can read
// them. install.sh states the same 700, but only on the branch where it has a
// service account to hand the installation to: the root fallback, the container
// image and a plain `npm start` all get their data directory from here instead,
// which is to say the installs the script itself flags as the less safe ones
// were the ones that got no mode at all.
//
// Creation only, deliberately. A directory that is already there keeps the mode
// its operator gave it, which is the policy install.sh states beside its own
// chmod: this decides how a directory is made, not what an existing installation
// is allowed to look like.
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
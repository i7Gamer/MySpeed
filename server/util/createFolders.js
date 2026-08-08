import fs from 'node:fs';
import path from 'node:path';

const baseDir = process.cwd();

const neededFolder = ["data", "bin", "data/logs", "data/servers", "data/certs"];

neededFolder.forEach(folder => {
    const fullPath = path.join(baseDir, folder);
    if (!fs.existsSync(fullPath)) {
        try {
            fs.mkdirSync(fullPath, {recursive: true});
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
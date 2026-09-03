import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * client/vite.config.mjs cannot change its outDir - scripts/generate-client-embed.js
 * and server/app.js both read a `build/` directory at the repository root, not
 * inside client/ - so every packaging path (build:binary, build:binary:baseline,
 * and the CI workflows that mirror them) needs the same move performed after the
 * client build runs: drop whatever is already at <root>/build, then relocate
 * client/build there. This is that move, written once so nothing duplicates it.
 */
export const moveClientBuild = (rootDir = path.join(import.meta.dirname, '..')) => {
    const clientBuild = path.join(rootDir, 'client', 'build');
    const rootBuild = path.join(rootDir, 'build');

    if (!fs.existsSync(clientBuild))
        throw new Error(`${clientBuild} does not exist - run the client build ("bun run build" in client/) first`);

    if (fs.existsSync(rootBuild))
        fs.rmSync(rootBuild, {recursive: true, force: true});

    fs.renameSync(clientBuild, rootBuild);

    return rootBuild;
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
    try {
        const rootBuild = moveClientBuild(process.argv[2]);
        console.log(`Moved client/build to ${rootBuild}`);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

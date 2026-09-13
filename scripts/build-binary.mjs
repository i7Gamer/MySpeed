import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_ENTRYPOINT = "server/index.js";
const HARFBUZZ_PACKAGE = "harfbuzzjs";
const HARFBUZZ_ADAPTER = path.join(SCRIPT_DIRECTORY, "binary", "embedded-harfbuzz.mjs");
const PRODUCTION_EXTERNALS = ["pg", "pg-hstore"];
const WINDOWS_TARGET_PREFIX = "bun-windows-";
const WINDOWS_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
export const QUALIFIED_BUN_VERSION = "1.4.2";

export const assertQualifiedBunRuntime = (runtimeVersion) => {
    if (runtimeVersion === QUALIFIED_BUN_VERSION) return;
    const received = runtimeVersion ?? "non-Bun runtime";
    throw new Error(`Standalone binary compilation requires Bun ${QUALIFIED_BUN_VERSION}; received ${received}`);
};

const valueAfter = (argumentsList, index, option) => {
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
};

export const parseBuildArguments = (argumentsList) => {
    const parsed = {entrypoint: DEFAULT_ENTRYPOINT};

    for (let index = 0; index < argumentsList.length; index++) {
        const option = argumentsList[index];
        const equalsAt = option.indexOf("=");
        const name = equalsAt === -1 ? option : option.slice(0, equalsAt);
        const value = equalsAt === -1
            ? valueAfter(argumentsList, index++, name)
            : option.slice(equalsAt + 1);

        if (!value) throw new Error(`${name} requires a value`);

        switch (name) {
            case "--target": parsed.target = value; break;
            case "--outfile": parsed.outfile = value; break;
            case "--windows-version": parsed.windowsVersion = value; break;
            case "--entrypoint": parsed.entrypoint = value; break;
            default: throw new Error(`Unsupported build argument: ${name}`);
        }
    }

    if (!parsed.outfile) throw new Error("--outfile is required");
    if (parsed.windowsVersion) {
        if (!parsed.target?.startsWith(WINDOWS_TARGET_PREFIX))
            throw new Error("Windows version metadata requires an explicit Windows target");
        if (!WINDOWS_VERSION_PATTERN.test(parsed.windowsVersion))
            throw new Error("Windows version must contain four numeric fields");
    }

    return parsed;
};

export const createHarfBuzzPlugin = (adapterPath) => ({
    name: "embedded-harfbuzz",
    setup(build) {
        build.onResolve({filter: /^harfbuzzjs$/}, () => ({path: adapterPath}));
    },
});

export const assertCompatibleHarfBuzz = ({
    installedVersion,
    satoriDependency,
    directDependency,
}) => {
    if (!directDependency)
        throw new Error(`${HARFBUZZ_PACKAGE} must be declared as a direct dependency`);
    if (directDependency !== installedVersion)
        throw new Error(`Direct ${HARFBUZZ_PACKAGE} dependency ${directDependency} does not match installed ${installedVersion}`);
    if (satoriDependency !== installedVersion)
        throw new Error(`Satori requires ${HARFBUZZ_PACKAGE} ${satoriDependency}, but ${installedVersion} is installed`);
};

const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));

export const checkInstalledHarfBuzz = (root = PROJECT_ROOT) => {
    const project = readJson(path.join(root, "package.json"));
    const satori = readJson(path.join(root, "node_modules", "satori", "package.json"));
    const harfbuzz = readJson(path.join(root, "node_modules", HARFBUZZ_PACKAGE, "package.json"));

    assertCompatibleHarfBuzz({
        installedVersion: harfbuzz.version,
        satoriDependency: satori.dependencies?.[HARFBUZZ_PACKAGE],
        directDependency: project.dependencies?.[HARFBUZZ_PACKAGE],
    });
};

export const createBuildOptions = ({
    root = PROJECT_ROOT,
    entrypoint = DEFAULT_ENTRYPOINT,
    outfile,
    target,
    windowsVersion,
    adapterPath = HARFBUZZ_ADAPTER,
}) => {
    const compile = {
        autoloadPackageJson: true,
        ...(target ? {target} : {}),
        outfile: path.resolve(root, outfile),
        ...(windowsVersion ? {windows: {version: windowsVersion}} : {}),
    };

    return {
        root,
        entrypoints: [path.resolve(root, entrypoint)],
        external: [...PRODUCTION_EXTERNALS],
        plugins: [createHarfBuzzPlugin(adapterPath)],
        compile,
    };
};

export const buildBinary = async (configuration, build = globalThis.Bun?.build,
    runtimeVersion = process.versions.bun) => {
    assertQualifiedBunRuntime(runtimeVersion);
    if (!build) throw new Error("Standalone binaries must be built with Bun");

    checkInstalledHarfBuzz(configuration.root);
    const result = await build(createBuildOptions(configuration));
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        throw new Error("Standalone binary compilation failed");
    }
    return result;
};

if (import.meta.main) {
    const parsed = parseBuildArguments(process.argv.slice(2));
    await buildBinary({...parsed, root: PROJECT_ROOT});
}

import fs from "node:fs";
import {pathToFileURL} from "node:url";

const NONCE = /^[a-f0-9]{32}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const EXPECTED_NODE_VERSION = "22.19.0";
const IMAGE_ROOT_PREFIX = "/home/runner/work/_temp/myspeed-windows-cpu-floor-";
const FILE_TYPE_MASK = 0o170000n;
const REGULAR_FILE_TYPE = 0o100000n;
const PERMISSION_MASK = 0o777n;
const SEALED_MODE = 0o444;

function exactKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} keys are invalid`);
}

function exactString(value, pattern, label) {
    if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
    return value;
}

function assertNativeRuntime(environment = process.env, runtime = {platform: process.platform,
    architecture: process.arch, nodeVersion: process.versions.node, uid: process.getuid?.(), gid: process.getgid?.()}) {
    if (runtime.platform !== "linux" || runtime.architecture !== "x64" ||
        runtime.nodeVersion !== EXPECTED_NODE_VERSION || runtime.uid !== 0 || runtime.gid !== 0 ||
        environment.GITHUB_ACTIONS !== "true" ||
        environment.CI !== "true" || environment.RUNNER_OS !== "Linux" || environment.RUNNER_ARCH !== "X64" ||
        environment.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("privileged sealing runtime is invalid");
}

function validateStat(value, label) {
    if (!value || typeof value.isFile !== "function" || !value.isFile() ||
        typeof value.dev !== "bigint" || value.dev < 1n || typeof value.ino !== "bigint" || value.ino < 1n ||
        value.nlink !== 1n || typeof value.size !== "bigint" || value.size < 1n || typeof value.uid !== "bigint" ||
        typeof value.gid !== "bigint" || typeof value.mode !== "bigint" ||
        (value.mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) throw new Error(`${label} identity is invalid`);
    return value;
}

const nativeOperations = Object.freeze({
    assertRuntime: assertNativeRuntime,
    openReadNoFollow: target => fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    readDescriptorPath: descriptor => fs.realpathSync(`/proc/self/fd/${descriptor}`),
    fstat: descriptor => fs.fstatSync(descriptor, {bigint: true}),
    fchown: (descriptor, uid, gid) => fs.fchownSync(descriptor, uid, gid),
    fchmod: (descriptor, mode) => fs.fchmodSync(descriptor, mode),
    close: descriptor => fs.closeSync(descriptor)
});

export function sealInstalledBaseDescriptor(request, operations = nativeOperations) {
    exactKeys(request, ["dev", "ino", "nonce", "path"], "installed base seal request");
    const nonce = exactString(request.nonce, NONCE, "installed base seal nonce");
    const expectedPath = `${IMAGE_ROOT_PREFIX}${nonce}/system.qcow2`;
    if (request.path !== expectedPath) throw new TypeError("installed base seal path is invalid");
    const expectedDev = BigInt(exactString(request.dev, POSITIVE_DECIMAL, "installed base seal device"));
    const expectedIno = BigInt(exactString(request.ino, POSITIVE_DECIMAL, "installed base seal inode"));
    for (const name of ["assertRuntime", "openReadNoFollow", "readDescriptorPath", "fstat", "fchown", "fchmod",
        "close"])
        if (typeof operations?.[name] !== "function") throw new TypeError("privileged sealing operation is absent");
    operations.assertRuntime();
    const descriptor = operations.openReadNoFollow(expectedPath);
    try {
        if (operations.readDescriptorPath(descriptor) !== expectedPath)
            throw new Error("installed base descriptor path differs");
        const before = validateStat(operations.fstat(descriptor), "installed base before descriptor seal");
        if (before.dev !== expectedDev || before.ino !== expectedIno)
            throw new Error("installed base descriptor identity differs");
        operations.fchown(descriptor, 0, 0);
        operations.fchmod(descriptor, SEALED_MODE);
        if (operations.readDescriptorPath(descriptor) !== expectedPath)
            throw new Error("installed base descriptor path changed while sealing");
        const after = validateStat(operations.fstat(descriptor), "installed base after descriptor seal");
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.uid !== 0n || after.gid !== 0n || (after.mode & PERMISSION_MASK) !== BigInt(SEALED_MODE))
            throw new Error("installed base descriptor seal differs");
        return Object.freeze({path: expectedPath, dev: after.dev.toString(), ino: after.ino.toString(),
            uid: after.uid.toString(), gid: after.gid.toString(), mode: SEALED_MODE.toString(8)});
    } finally { operations.close(descriptor); }
}

function parseArguments(argv) {
    if (argv.length !== 9 || argv[0] !== "seal" || argv[1] !== "--nonce" || argv[3] !== "--path" ||
        argv[5] !== "--dev" || argv[7] !== "--ino") throw new TypeError("arguments are invalid");
    return {nonce: argv[2], path: argv[4], dev: argv[6], ino: argv[8]};
}

async function main() {
    sealInstalledBaseDescriptor(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : "privileged sealing failed"}\n`);
        process.exitCode = 1;
    });
}

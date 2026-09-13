#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkPopulatedDatabase } from "./sqlite-check.mjs";

export const SYNTHETIC_PASSWORD = "QaOnly-7f3c-Pass";
export const CONFIG_SENTINEL = "123.456";
export const TEST_RESULT_SENTINEL = "qualification-seed-row";
export const FIXTURE_MARKER = ".myspeed-qualification.json";
export const HANDOFF_SCHEMA_VERSION = 1;

const PROVIDER_CATALOGUES = ["ookla.json", "librespeed.json"];
const PROVIDER_BINARIES = ["speedtest", "librespeed-cli", "cfspeedtest", "iperf3"];
const WINDOWS_SUFFIX = ".exe";
const DIRECTORY_MODE = 0o700;
const EXECUTABLE_MODE = 0o700;
const NONCE_BYTES = 24;
const SHA256_HEX_LENGTH = 64;
const SQLITE_FILE = "storage.db";
const FIXTURE_PROCESS_TIMEOUT_MS = 30_000;
const MAX_UID = 0xffff_ffff;
const UNCHANGED_GID = -1;

const assertDirectoryEntries = (directory, label, allowedEntries = []) => {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Pre-existing fixture ${label} is not a safe directory: ${directory}`);

    const allowed = new Set(allowedEntries);
    const unexpected = fs.readdirSync(directory).filter((entry) => !allowed.has(entry));
    if (unexpected.length > 0)
        throw new Error(`Refusing pre-existing fixture ${label}: ${unexpected.join(", ")}`);
};

export const assertFreshFixturePaths = ({work, allowedExistingBinaries = []}) => {
    const root = containedDirectory(work, "Fixture work directory");
    assertDirectoryEntries(path.join(root, "data"), "data", []);
    assertDirectoryEntries(path.join(root, "bin"), "binary", allowedExistingBinaries);
};

const parseArguments = (values) => {
    const [command, ...rest] = values;
    const options = {};

    for (let index = 0; index < rest.length; index += 2) {
        const name = rest[index];
        const value = rest[index + 1];
        if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid fixture argument "${name ?? ""}"`);
        options[name.slice(2)] = value;
    }

    if (!new Set(["seed", "static", "check", "handoff"]).has(command))
        throw new Error("Fixture command must be seed, static, check, or handoff");
    const requiredOptions = command === "handoff"
        ? ["repo", "work", "reset-work", "manifest", "source-sha"]
        : ["repo", "work", "nonce"];
    for (const required of requiredOptions)
        if (!options[required]) throw new Error(`Missing --${required}`);

    return {command, ...options};
};

const containedDirectory = (candidate, label) => {
    const resolved = path.resolve(candidate);
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a safe directory: ${resolved}`);
    return resolved;
};

const writeExclusive = (file, contents, mode) => {
    const descriptor = fs.openSync(file, "wx", mode);
    try {
        fs.writeFileSync(descriptor, contents);
    } finally {
        fs.closeSync(descriptor);
    }
};

const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const inventoryHashes = (root) => {
    const files = [];
    const visit = (directory) => {
        for (const name of fs.readdirSync(directory)) {
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error(`Fixture inventory contains a symbolic link: ${file}`);
            if (stat.isDirectory()) visit(file);
            else if (stat.isFile()) files.push(file);
            else throw new Error(`Fixture inventory contains a special file: ${file}`);
        }
    };
    visit(root);
    return Object.fromEntries(files.sort().map((file) =>
        [path.relative(root, file).replaceAll(path.sep, "/"), sha256File(file)]));
};

const assertInventory = (root, expected) => {
    if (!expected || typeof expected !== "object" || Array.isArray(expected))
        throw new Error("Preseeded fixture file inventory is malformed");
    const actual = inventoryHashes(root);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Preseeded fixture file inventory does not match: ${root}`);
};

const gitCommit = (repository) => {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {cwd: repository, encoding: "utf8"}).trim();
    } catch {
        return null;
    }
};

const runJsonCommand = (runtime, args, options) => {
    const output = execFileSync(runtime, args, {
        ...options,
        encoding: "utf8",
        timeout: FIXTURE_PROCESS_TIMEOUT_MS
    });
    return JSON.parse(output.trim().split(/\r?\n/).at(-1));
};

const isWithin = (parent, candidate) => {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
};

const assertReadOnlyFile = (file, open = fs.openSync, close = fs.closeSync) => {
    let descriptor;
    try {
        descriptor = open(file, "a");
    } catch (error) {
        if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return;
        throw error;
    }
    close(descriptor);
    throw new Error(`Preseeded fixture manifest is writable at runtime: ${file}`);
};

const readOwnedMarker = (root, expectedNonce, expectedHash) => {
    const markerFile = path.join(root, FIXTURE_MARKER);
    const stat = fs.lstatSync(markerFile);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Preseeded fixture marker is not a regular file: ${markerFile}`);
    if (sha256File(markerFile) !== expectedHash)
        throw new Error(`Preseeded fixture marker hash does not match: ${markerFile}`);
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    if (marker.nonce !== expectedNonce || path.resolve(marker.root) !== root)
        throw new Error(`Preseeded fixture marker identity does not match: ${markerFile}`);
    return marker;
};

/**
 * Makes only a nonce-proven fixture tree accessible to an unprivileged child.
 * The full tree is inspected before the first ownership change so a symlink,
 * special file, or external hard link fails without partially mutating it.
 */
export const makeFixtureAccessibleToUid = ({work, nonce, uid,
    lstat = fs.lstatSync, readdir = fs.readdirSync, chown = fs.chownSync}) => {
    if (!/^\d+$/.test(uid)) throw new Error("Fixture UID must be a nonnegative integer");
    const numericUid = Number(uid);
    if (!Number.isSafeInteger(numericUid) || numericUid > MAX_UID)
        throw new Error("Fixture UID is outside the supported range");

    const root = path.resolve(work);
    const rootStat = lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error(`Fixture root is not a safe directory: ${root}`);
    const markerPath = path.join(root, FIXTURE_MARKER);
    const marker = readOwnedMarker(root, nonce, sha256File(markerPath));
    const dataDirectory = path.join(root, "data");
    const binaryDirectory = path.join(root, "bin");
    if (path.resolve(marker.dataDirectory ?? "") !== dataDirectory
        || path.resolve(marker.binaryDirectory ?? "") !== binaryDirectory)
        throw new Error(`Fixture marker identity does not match its owned paths: ${markerPath}`);

    const targets = [root];
    const inspect = (file) => {
        const stat = lstat(file);
        if (stat.isSymbolicLink()) throw new Error(`Fixture ownership tree contains a symbolic link: ${file}`);
        targets.push(file);
        if (stat.isDirectory()) {
            for (const name of readdir(file)) inspect(path.join(file, name));
        } else if (!stat.isFile()) {
            throw new Error(`Fixture ownership tree contains a special file: ${file}`);
        } else if (stat.nlink !== undefined && stat.nlink !== 1) {
            throw new Error(`Fixture ownership tree contains a linked file: ${file}`);
        }
    };
    inspect(markerPath);
    inspect(dataDirectory);
    inspect(binaryDirectory);

    for (const target of targets) chown(target, numericUid, UNCHANGED_GID);
};

export const prepareStaticFixtures = ({work, nonce, platform = process.platform, allowedExistingBinaries = []}) => {
    const root = containedDirectory(work, "Fixture work directory");
    const markerPath = path.join(root, FIXTURE_MARKER);
    if (fs.existsSync(markerPath)) throw new Error(`Refusing stale fixture directory: ${root}`);
    assertFreshFixturePaths({work: root, allowedExistingBinaries});

    const dataDirectory = path.join(root, "data");
    const serverDirectory = path.join(dataDirectory, "servers");
    const binaryDirectory = path.join(root, "bin");
    fs.mkdirSync(serverDirectory, {recursive: true, mode: DIRECTORY_MODE});
    fs.mkdirSync(binaryDirectory, {recursive: true, mode: DIRECTORY_MODE});
    fs.chmodSync(dataDirectory, DIRECTORY_MODE);

    for (const name of PROVIDER_CATALOGUES)
        writeExclusive(path.join(serverDirectory, name), "{}\n", 0o600);

    const suffix = platform === "win32" ? WINDOWS_SUFFIX : "";
    for (const name of PROVIDER_BINARIES) {
        const file = path.join(binaryDirectory, name + suffix);
        if (fs.existsSync(file)) continue;
        writeExclusive(file, `MySpeed qualification fixture ${nonce}\n`, EXECUTABLE_MODE);
    }

    const marker = {nonce, root, dataDirectory, binaryDirectory, createdAt: new Date().toISOString()};
    writeExclusive(markerPath, JSON.stringify(marker, null, 2) + "\n", 0o600);
    return marker;
};

const importFrom = (repo, relativePath) => import(pathToFileURL(path.join(repo, relativePath)).href);

export const seedDatabase = async ({repo, work, nonce, "allow-existing-binary": allowedExistingBinary}) => {
    const repository = containedDirectory(repo, "Repository directory");
    const allowedExistingBinaries = allowedExistingBinary ? [allowedExistingBinary] : [];
    const marker = prepareStaticFixtures({work, nonce, allowedExistingBinaries});
    const previousDirectory = process.cwd();
    const previousEnvironment = {
        DB_TYPE: process.env.DB_TYPE,
        RUN_TEST_ON_STARTUP: process.env.RUN_TEST_ON_STARTUP,
        PREVIEW_MODE: process.env.PREVIEW_MODE
    };
    process.chdir(marker.root);
    process.env.DB_TYPE = "sqlite";
    process.env.RUN_TEST_ON_STARTUP = "false";
    delete process.env.PREVIEW_MODE;

    let db;
    try {
        ({default: db} = await importFrom(repository, "server/config/database.js"));
        const {runMigrations} = await importFrom(repository, "server/util/migrationRunner.js");
        await db.authenticate();
        await runMigrations();

        const config = await importFrom(repository, "server/controller/config.js");
        const {default: Config} = await importFrom(repository, "server/models/Config.js");
        const {default: Speedtests} = await importFrom(repository, "server/models/Speedtests.js");

        await config.insertDefaults();
        const password = await config.validateInput("password", SYNTHETIC_PASSWORD);
        if (!password || typeof password === "string")
            throw new Error(`Could not create synthetic password: ${password}`);

        const [passwordRows] = await Config.update({value: password.value}, {where: {key: "password"}});
        const [sentinelRows] = await Config.update({value: CONFIG_SENTINEL}, {where: {key: "ping"}});
        if (passwordRows !== 1 || sentinelRows !== 1)
            throw new Error("Synthetic configuration rows were not seeded exactly once");
        await Speedtests.create({
            ping: 7.25,
            jitter: 0.5,
            download: 321.5,
            upload: 123.25,
            provider: "cloudflare",
            type: "manual",
            resultId: TEST_RESULT_SENTINEL,
            time: 1_000,
            created: new Date().toISOString()
        });

        return marker;
    } finally {
        await db?.close().catch(() => undefined);
        process.chdir(previousDirectory);
        for (const [key, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

export const checkDatabase = async ({repo, work, nonce}) => {
    const repository = containedDirectory(repo, "Repository directory");
    const root = containedDirectory(work, "Fixture work directory");
    const markerPath = path.join(root, FIXTURE_MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.nonce !== nonce || path.resolve(marker.root) !== root)
        throw new Error("Fixture marker does not belong to this verification run");

    process.chdir(root);
    process.env.DB_TYPE = "sqlite";
    const {default: db} = await importFrom(repository, "server/config/database.js");

    try {
        await db.authenticate();
        const integrity = await db.query("PRAGMA quick_check", {type: "SELECT"});
        if (!integrity.some((row) => Object.values(row).includes("ok")))
            throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);

        const configRows = await db.query("SELECT value FROM config WHERE key = 'ping'", {type: "SELECT"});
        if (configRows[0]?.value !== CONFIG_SENTINEL) throw new Error("Synthetic configuration did not persist");

        const testRows = await db.query("SELECT resultId FROM speedtests WHERE resultId = ?", {
            replacements: [TEST_RESULT_SENTINEL], type: "SELECT"
        });
        if (testRows.length !== 1) throw new Error("Synthetic speed-test row did not persist exactly once");

        return {integrity: "ok", config: CONFIG_SENTINEL, resultId: TEST_RESULT_SENTINEL};
    } finally {
        await db.close().catch(() => undefined);
    }
};

export const createHandoffFixture = async ({repo, work, resetWork, manifest, sourceSha}) => {
    const repository = containedDirectory(repo, "Repository directory");
    const populatedRoot = containedDirectory(work, "Populated handoff work directory");
    const resetRoot = containedDirectory(resetWork, "Reset handoff work directory");
    const manifestFile = path.resolve(manifest);
    if (!path.isAbsolute(manifest)) throw new Error("--manifest must be an absolute path");
    if (populatedRoot === resetRoot) throw new Error("Handoff work directories must be distinct");
    if (isWithin(populatedRoot, manifestFile) || isWithin(resetRoot, manifestFile))
        throw new Error("Handoff manifest must be outside both artifact work directories");
    containedDirectory(path.dirname(manifestFile), "Handoff manifest directory");
    if (fs.existsSync(manifestFile)) throw new Error(`Refusing existing handoff manifest: ${manifestFile}`);
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("--source-sha must be a lowercase 40-character commit SHA");
    const repositoryCommit = gitCommit(repository);
    if (repositoryCommit && repositoryCommit !== sourceSha)
        throw new Error(`--source-sha ${sourceSha} does not match repository HEAD ${repositoryCommit}`);

    const populatedNonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
    const resetNonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
    const fixtureScript = fileURLToPath(import.meta.url);
    runJsonCommand(process.execPath, [
        fixtureScript, "seed", "--repo", repository, "--work", populatedRoot, "--nonce", populatedNonce
    ], {cwd: repository, env: process.env});
    prepareStaticFixtures({work: resetRoot, nonce: resetNonce});

    const databaseFile = path.join(populatedRoot, "data", SQLITE_FILE);
    const sqliteCheckScript = fileURLToPath(new URL("./sqlite-check.mjs", import.meta.url));
    const snapshot = runJsonCommand(process.execPath, [
        sqliteCheckScript, "inspect-populated", "--file", databaseFile, "--result-id", TEST_RESULT_SENTINEL
    ], {cwd: populatedRoot, env: process.env});
    const expected = {
        ping: CONFIG_SENTINEL,
        resultId: TEST_RESULT_SENTINEL,
        passwordValueSha256: snapshot.passwordValueSha256
    };
    const handoff = {
        schemaVersion: HANDOFF_SCHEMA_VERSION,
        source: {
            commit: sourceSha,
            bunLockSha256: sha256File(path.join(repository, "bun.lock")),
            packageSha256: sha256File(path.join(repository, "package.json"))
        },
        populated: {
            root: populatedRoot,
            nonce: populatedNonce,
            markerSha256: sha256File(path.join(populatedRoot, FIXTURE_MARKER)),
            databaseSha256: sha256File(databaseFile),
            filesSha256: inventoryHashes(populatedRoot)
        },
        reset: {
            root: resetRoot,
            nonce: resetNonce,
            markerSha256: sha256File(path.join(resetRoot, FIXTURE_MARKER)),
            filesSha256: inventoryHashes(resetRoot)
        },
        expected
    };
    writeExclusive(manifestFile, JSON.stringify(handoff, null, 2) + "\n", 0o600);
    return handoff;
};

export const loadHandoffFixture = async ({file, work, resetWork, requireReadOnly = true}) => {
    if (!path.isAbsolute(file)) throw new Error("Preseeded fixture manifest path must be absolute");
    const manifestFile = path.resolve(file);
    const manifestStat = fs.lstatSync(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
        throw new Error("Preseeded fixture manifest must be a regular file");
    if (requireReadOnly) assertReadOnlyFile(manifestFile);
    const handoff = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (handoff.schemaVersion !== HANDOFF_SCHEMA_VERSION)
        throw new Error(`Unsupported fixture handoff schema version ${handoff.schemaVersion}`);
    if (!/^[0-9a-f]{40}$/.test(handoff.source?.commit ?? ""))
        throw new Error("Preseeded fixture source commit is malformed");

    const populatedRoot = containedDirectory(work, "Populated handoff work directory");
    const resetRoot = containedDirectory(resetWork, "Reset handoff work directory");
    if (populatedRoot === resetRoot) throw new Error("Handoff work directories must be distinct");
    if (path.resolve(handoff.populated?.root ?? "") !== populatedRoot
        || path.resolve(handoff.reset?.root ?? "") !== resetRoot)
        throw new Error("Preseeded fixture work paths do not match the handoff manifest");
    for (const entry of [handoff.populated, handoff.reset])
        if (!new RegExp(`^[0-9a-f]{${NONCE_BYTES * 2}}$`).test(entry?.nonce ?? ""))
            throw new Error("Preseeded fixture nonce is malformed");
    for (const digest of [handoff.populated.markerSha256, handoff.populated.databaseSha256,
        handoff.reset.markerSha256, handoff.expected?.passwordValueSha256,
        handoff.source?.bunLockSha256, handoff.source?.packageSha256])
        if (typeof digest !== "string" || digest.length !== SHA256_HEX_LENGTH || !/^[0-9a-f]+$/.test(digest))
            throw new Error("Preseeded fixture manifest contains a malformed SHA-256 digest");

    readOwnedMarker(populatedRoot, handoff.populated.nonce, handoff.populated.markerSha256);
    readOwnedMarker(resetRoot, handoff.reset.nonce, handoff.reset.markerSha256);
    assertInventory(populatedRoot, handoff.populated.filesSha256);
    assertInventory(resetRoot, handoff.reset.filesSha256);
    const databaseFile = path.join(populatedRoot, "data", SQLITE_FILE);
    if (sha256File(databaseFile) !== handoff.populated.databaseSha256)
        throw new Error("Preseeded fixture database hash does not match its handoff manifest");
    if (fs.existsSync(path.join(resetRoot, "data", SQLITE_FILE)))
        throw new Error("Preseeded reset work unexpectedly contains a database");
    if (handoff.expected.ping !== CONFIG_SENTINEL || handoff.expected.resultId !== TEST_RESULT_SENTINEL)
        throw new Error("Preseeded fixture sentinels do not match this verifier");
    const initialDatabase = await checkPopulatedDatabase(databaseFile, handoff.expected);
    return {...handoff, manifestFile, initialDatabase};
};

const main = async () => {
    const options = parseArguments(process.argv.slice(2));
    const result = options.command === "handoff"
        ? await createHandoffFixture({
            repo: options.repo,
            work: options.work,
            resetWork: options["reset-work"],
            manifest: options.manifest,
            sourceSha: options["source-sha"]
        })
        : options.command === "seed"
        ? await seedDatabase(options)
        : options.command === "static"
            ? prepareStaticFixtures(options)
            : await checkDatabase(options);
    process.stdout.write(JSON.stringify(result) + "\n");
};

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
});

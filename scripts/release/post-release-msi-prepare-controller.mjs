import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";

import {bindV161PostReleaseTarget} from "./post-release-target.mjs";
import {createV161PostReleaseMsiEnvelope} from "./post-release-msi-envelope.mjs";
import {buildV161PostReleaseMsiAcquisitionPlan, createV161PostReleaseMsiAcquisitionRecord,
    validateV161PostReleaseMsiAcquisitionRecord} from "./post-release-msi-acquisition.mjs";
import {createWindowsHostedMsiPrepareOperations, prepareV161PostReleaseMsiOnWindows,
    validateV161PostReleaseMsiWindowsPreparation} from "./post-release-msi-hosted-prepare.mjs";
import {buildV161PostReleaseMsiFixturePlan, createWindowsHostedMsiFixtureOperations,
    prepareV161PostReleaseMsiFixturesOnWindows, validateV161PostReleaseMsiFixturePreparation} from
    "./post-release-msi-fixture-preparation.mjs";

const REQUIRED_ENVIRONMENT = ["GITHUB_ACTIONS", "CI", "GITHUB_REPOSITORY", "GITHUB_SHA",
    "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH",
    "RUNNER_ENVIRONMENT"];
const fail = message => { throw new Error(`Post-release MSI prepare controller: ${message}`); };
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const exactEnvironment = environment => {
    for (const name of REQUIRED_ENVIRONMENT) if (typeof environment[name] !== "string"
        || environment[name].length === 0) fail(`${name} is absent`);
    if (environment.GITHUB_ACTIONS !== "true" || environment.CI !== "true"
        || environment.GITHUB_REPOSITORY !== "i7Gamer/MySpeed" || environment.RUNNER_OS !== "Windows"
        || environment.RUNNER_ARCH !== "X64" || environment.RUNNER_ENVIRONMENT !== "github-hosted"
        || !/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA)) fail("hosted environment differs");
};
const argumentsByName = argv => {
    if (argv.length !== 22) fail("arguments differ");
    const result = {};
    for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
    for (const name of ["--captured", "--manifest", "--root", "--fixture-root", "--fixture-work",
        "--wix-dark", "--wix-candle", "--wix-light", "--fixture-proof", "--output", "--pwsh"])
        if (typeof result[name] !== "string") fail(`${name} is absent`);
    return result;
};

export const runV161PostReleaseMsiPrepare = async ({environment, captured, manifestBytes,
    acquisitionRoot, fixtureOutputRoot, fixtureInspectionRoot, wix, outputPath, powershellPath,
    fixtureProofPath, operations, fixtureOperations, now = () => new Date()}) => {
    exactEnvironment(environment);
    const context = {repository: environment.GITHUB_REPOSITORY, sourceSha: environment.GITHUB_SHA,
        eventSha: environment.GITHUB_SHA, runId: environment.GITHUB_RUN_ID,
        runAttempt: environment.GITHUB_RUN_ATTEMPT, imageVersion: environment.ImageVersion,
        nonce: createHash("sha256").update(`${environment.GITHUB_RUN_ID}\0${environment.GITHUB_RUN_ATTEMPT}`
            + `\0${environment.GITHUB_SHA}`, "utf8").digest("hex").slice(0, 32)};
    const target = bindV161PostReleaseTarget({...captured, harnessSourceSha: environment.GITHUB_SHA,
        observedAt: now().toISOString().replace(/\.\d{3}Z$/u, "Z"), manifestBytes});
    const envelope = createV161PostReleaseMsiEnvelope(target, context);
    const plan = buildV161PostReleaseMsiAcquisitionPlan(envelope, context, acquisitionRoot);
    fs.mkdirSync(path.dirname(acquisitionRoot), {recursive: true});
    const hostOperations = operations ?? createWindowsHostedMsiPrepareOperations({powershellPath,
        scriptPath: path.resolve("scripts/release/post-release-msi-hosted-prepare.ps1")});
    const preparation = await prepareV161PostReleaseMsiOnWindows(plan, hostOperations);
    validateV161PostReleaseMsiWindowsPreparation(preparation, plan);
    const acquisition = createV161PostReleaseMsiAcquisitionRecord(plan, preparation.files,
        preparation.runtime.local);
    validateV161PostReleaseMsiAcquisitionRecord(acquisition, plan);
    const fixturePlan = buildV161PostReleaseMsiFixturePlan({acquisitionPlan: plan,
        windowsPreparation: preparation, outputRoot: fixtureOutputRoot});
    const hostedFixtureOperations = fixtureOperations ?? createWindowsHostedMsiFixtureOperations({
        powershellPath, scriptPath: path.resolve("scripts/release/post-release-msi-fixture-preparation.ps1"),
        inspectionRoot: fixtureInspectionRoot, wix});
    const fixturePreparation = await prepareV161PostReleaseMsiFixturesOnWindows(fixturePlan,
        hostedFixtureOperations);
    validateV161PostReleaseMsiFixturePreparation(fixturePreparation, fixturePlan);
    const result = {schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-msi-prepare-result",
        status: "prepared", qualifying: false, installerExecution: false, releaseGatesCleared: [],
        target: structuredClone(target), envelope: structuredClone(envelope), acquisition,
        windowsPreparation: structuredClone(preparation), inspections: preparation.inspections,
        fixturePreparation: structuredClone(fixturePreparation),
        pending: ["linux-transport-reobservation"]};
    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    fs.writeFileSync(fixtureProofPath, `${JSON.stringify(fixturePreparation)}\n`,
        {encoding: "utf8", flag: "wx"});
    fs.writeFileSync(outputPath, `${JSON.stringify(result)}\n`, {encoding: "utf8", flag: "wx"});
    return result;
};

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
    const args = argumentsByName(process.argv.slice(2));
    runV161PostReleaseMsiPrepare({environment: process.env, captured: readJson(args["--captured"]),
        manifestBytes: fs.readFileSync(args["--manifest"]), acquisitionRoot: args["--root"],
        fixtureOutputRoot: args["--fixture-root"], fixtureInspectionRoot: args["--fixture-work"],
        wix: {darkPath: args["--wix-dark"], candlePath: args["--wix-candle"],
            lightPath: args["--wix-light"]}, outputPath: args["--output"],
        fixtureProofPath: args["--fixture-proof"],
        powershellPath: args["--pwsh"]}).then(result => {
        process.stdout.write(`${JSON.stringify({status: result.status, qualifying: result.qualifying})}\n`);
    }).catch(error => { process.stderr.write(`${String(error?.message ?? error).slice(0, 1024)}\n`);
        process.exitCode = 1; });
}

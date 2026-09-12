import {it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parse} from "yaml";
import {parse as parseJavaScript} from "espree";
import {readSource} from "../helpers/source.js";

const workflow = (name) => parse(readSource(`.github/workflows/${name}.yml`));
const all = () => fs.readdirSync(new URL("../../.github/workflows/", import.meta.url))
    .filter((name) => name.endsWith(".yml")).map((name) => [name, workflow(name.slice(0, -4))]);
const uses = (job, action) => job.steps?.filter((step) => step.uses?.startsWith(`${action}@`)) ?? [];
const buildNames = ["build-windows", "build-linux", "build-macos", "build-zip"];
const dockerSecrets = ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"];

const dependabotMerge = () => uses(workflow("merge-dependabot").jobs.merge, "actions/github-script")[0];
const TESTED_HEAD = "a".repeat(40);
const PR_NUMBER = 42;

it("runs native and compiled transports on both release runtime platforms", () => {
    const config = workflow("test");
    const job = config.jobs.transport;
    assert.ok(job, "native transport behavior must have a persistent CI gate");
    assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
    assert.equal(job["runs-on"], "${{ matrix.os }}");
    assert.equal(job.if, config.jobs.checks.if);
    assert.equal((job.permissions ?? config.permissions).contents, "read");
    const bun = uses(job, "oven-sh/setup-bun")[0];
    for (const name of ["build-windows", "build-linux", "build-macos"])
        assert.equal(bun.with["bun-version"], uses(workflow("build-binaries").jobs[name], "oven-sh/setup-bun")[0].with["bun-version"]);
    const commands = job.steps.map((step) => step.run ?? "").join("\n");
    assert.match(commands, /node --test \.\/tests\/server\/outboundTransportNative\.test\.js/);
    assert.match(commands, /bun test --timeout 60000 \.\/tests\/server\/outboundTransportNative\.test\.js/);
    assert.match(commands, /bun build --compile \.\/tests\/fixtures\/outbound-transport\/run\.mjs/);
    assert.match(commands, /& \$transportProbe/);
    assert.doesNotMatch(JSON.stringify(job), /--test-shard|continue-on-error/);
});

it("includes HTTP scenarios in both runtime entrypoints used by CI", () => {
    for (const file of ["tests/server/outboundTransportNative.test.js", "tests/fixtures/outbound-transport/run.mjs"]) {
        // Inspect executable wiring rather than accepting a comment mentioning
        // HTTP. These entrypoints run tests on import, so importing them here
        // would launch a second transport suite inside this workflow test.
        const tree = parseJavaScript(readSource(file), {ecmaVersion: "latest", sourceType: "module"});
        const httpImport = tree.body.find(node => node.type === "ImportDeclaration"
            && node.source.value.endsWith("/http/scenarios.js"));
        assert.ok(httpImport, `${file} omits the HTTP transport fixture`);
        const local = httpImport.specifiers.find(node => node.imported?.name === "httpScenarios")?.local.name;
        assert.ok(local, `${file} does not import the HTTP scenario list`);
        const arrays = tree.body.filter(node => node.type === "VariableDeclaration")
            .flatMap(node => node.declarations).filter(node => node.init?.type === "ArrayExpression");
        assert.ok(arrays.some(node => node.init.elements.some(element =>
            element.type === "SpreadElement" && element.argument.name === local)),
        `${file} imports HTTP cases without running them alongside the other transports`);
    }
});

const runDependabotMerge = async ({head = TESTED_HEAD, merged = false, readError, mergeError,
    mergeResult = true} = {}) => {
    const calls = [];
    const logs = [];
    const execute = () => vm.runInNewContext("(async () => {" + dependabotMerge()?.with.script + "})()", {
        process: {env: {TESTED_HEAD, PR_NUMBER: String(PR_NUMBER)}},
        context: {repo: {owner: "test", repo: "myspeed"}},
        core: {info: (message) => logs.push(message)},
        github: {rest: {pulls: {
            get: async (request) => {
                calls.push(["get", {...request}]);
                if (readError) throw readError;
                return {data: {head: {sha: head}, merged}};
            },
            merge: async (request) => {
                calls.push(["merge", {...request}]);
                if (mergeError) throw mergeError;
                return {data: {merged: mergeResult}};
            }
        }}}
    });
    return {calls, logs, execute};
};

it("Dependabot merges only the tested head with scoped cancellation and safe bindings", () => {
    const config = workflow("merge-dependabot");
    assert.equal(config.concurrency?.["cancel-in-progress"], true);
    for (const value of ["github.repository", "github.workflow", "github.event.pull_request.number"])
        assert.ok(config.concurrency.group.includes(value));
    const step = dependabotMerge();
    assert.ok(step, "merge must run as a portable github-script action");
    assert.equal(step.env.TESTED_HEAD, "${{ github.event.pull_request.head.sha }}");
    assert.equal(step.env.PR_NUMBER, "${{ github.event.pull_request.number }}");
    assert.doesNotMatch(step.with.script, /\$\{\{|enablePullRequestAutoMerge|--auto/);
    assert.match(step.if, /semver-major/);
    assert.match(step.if, /docker/);
});

it("Dependabot sends the tested SHA on the actual merge request", async () => {
    const {calls, execute} = await runDependabotMerge();
    await execute();
    assert.deepEqual(calls, [
        ["get", {owner: "test", repo: "myspeed", pull_number: PR_NUMBER}],
        ["merge", {owner: "test", repo: "myspeed", pull_number: PR_NUMBER, sha: TESTED_HEAD, merge_method: "merge"}]
    ]);
});

for (const state of [{head: "b".repeat(40)}, {merged: true}]) {
    it("Dependabot skips an explicitly superseded or already merged revision " + JSON.stringify(state), async () => {
        const {calls, logs, execute} = await runDependabotMerge(state);
        await execute();
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], "get");
        assert.equal(logs.length, 1);
    });
}

for (const state of [{readError: new Error("read failed")},
    {mergeError: Object.assign(new Error("head changed during merge"), {status: 409})}, {mergeResult: false}]) {
    it("Dependabot reports read, merge-race and unsuccessful-result failures " + JSON.stringify(state), async () => {
        const {execute} = await runDependabotMerge(state);
        await assert.rejects(execute);
    });
}

it("pins every external action and never persists checkout credentials", () => {
    for (const [file, config] of all()) {
        for (const job of Object.values(config.jobs)) {
            for (const step of job.steps ?? []) {
                if (!step.uses) continue;
                assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/, file);
                if (step.uses.startsWith("actions/checkout@"))
                    assert.equal(step.with?.["persist-credentials"], false, file);
            }
        }
    }
});

it("binary compilation and verification are build-only and read-only", () => {
    const config = workflow("build-binaries");
    for (const name of buildNames) {
        const job = config.jobs[name];
        assert.equal((job.permissions ?? config.permissions).contents, "read", name);
        assert.equal(uses(job, "actions/github-script").length, 0, name);
        assert.ok(uses(job, "actions/upload-artifact").length, name);
        assert.ok(uses(job, "actions/upload-artifact").every((step) => step.with.path.includes(".sha256")));
    }
    assert.equal(config.jobs["publish-binaries"], undefined);
    assert.equal(config.jobs.checksums, undefined);
});

it("MSI building cannot write releases", () => {
    const config = workflow("build-msi");
    const build = config.jobs["build-msi"];
    assert.equal((build.permissions ?? config.permissions).contents, "read");
    assert.equal(uses(build, "actions/github-script").length, 0);
    assert.equal(uses(build, "actions/upload-artifact").length, 1);
    assert.ok(uses(build, "actions/upload-artifact")[0].with.path.includes(".sha256"));
    assert.equal(config.jobs["publish-msi"], undefined);
});

it("only qualified Docker publication accepts registry secrets", () => {
    assert.equal(workflow("build-docker").on.workflow_call.secrets, undefined);
    assert.deepEqual(Object.keys(workflow("publish-docker").on.workflow_call.secrets).sort(), dockerSecrets);
    for (const [, config] of all()) {
        for (const job of Object.values(config.jobs)) {
            if (!job.uses) continue;
            if (/\/publish-docker\.yml$/.test(job.uses)) {
                assert.deepEqual(Object.keys(job.secrets).sort(), dockerSecrets);
                for (const key of dockerSecrets) assert.equal(job.secrets[key], `\${{ secrets.${key} }}`);
            } else assert.equal(job.secrets, undefined);
        }
    }
});

it("release finalization and Docker publication retain all qualification gates", () => {
    const jobs = workflow("create_release").jobs;
    for (const name of ["validate", "create-draft", "publish-assets"])
        assert.ok(jobs["publish-docker"].needs.includes(name), name);
    for (const name of ["publish-docker", "publish-assets"])
        assert.ok(jobs["finalize-release"].needs.includes(name), name);
    assert.ok(jobs["report-failure"].if.includes("failure()"));
});

it("Dependabot watches both Bun lockfiles, actions and Docker as structured entries", () => {
    const config = parse(readSource(".github/dependabot.yml"));
    assert.equal(config.version, 2);
    assert.deepEqual(config.updates.map((entry) => [entry["package-ecosystem"], entry.directory]).sort(),
        [["bun", "/"], ["bun", "/client"], ["docker", "/"], ["github-actions", "/"]].sort());
    for (const directory of ["", "client/"]) {
        const lock = parse(readSource(`${directory}bun.lock`));
        const manifest = JSON.parse(readSource(`${directory}package.json`));
        for (const section of ["dependencies", "devDependencies"])
            assert.deepEqual(lock.workspaces[""][section], manifest[section]);
    }
});

it("Dependabot reuses one test run without skipping human, fork, push or release tests", () => {
    const config = workflow("test");
    assert.equal(config.on.workflow_call.inputs["dependabot-call"].default, false);
    const caller = workflow("merge-dependabot").jobs.test;
    assert.equal(caller.with["dependabot-call"], true);
    assert.match(caller.if, /head.repo.full_name == github.repository/);
    const evaluate = (condition, github, inputs) => Function("github", "inputs", `return (${condition});`)(github, inputs);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
        for (const author of ["dependabot[bot]", "person"]) {
            for (const repository of ["i7Gamer/MySpeed", "fork/MySpeed"]) {
                for (const head of [repository, "elsewhere/MySpeed"]) {
                    for (const called of [false, true]) {
                        const github = {event_name: event, repository, event: {pull_request: {user: {login: author}, head: {repo: {full_name: head}}}}};
                        const skip = event === "pull_request" && author === "dependabot[bot]"
                            && repository === "i7Gamer/MySpeed" && head === repository && !called;
                        for (const job of Object.values(config.jobs))
                            assert.equal(evaluate(job.if, github, {"dependabot-call": called}), !skip);
                    }
                }
            }
        }
    }
});

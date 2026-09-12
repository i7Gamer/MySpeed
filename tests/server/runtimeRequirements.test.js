import {it} from "node:test";
import assert from "node:assert/strict";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const BUN_VERSION = "1.4.2";
const MINIMUM_NODE = "22.19.0";
const config = parse(readSource(".github/workflows/test.yml"));
const manifest = JSON.parse(readSource("package.json"));
const setup = (job, action) => job.steps.find(step => step.uses?.startsWith(`${action}@`));

it("declares the Node floor required by the pinned Undici release", () => {
    assert.equal(manifest.dependencies.undici, "8.10.2");
    assert.equal(manifest.engines.node, `>=${MINIMUM_NODE}`);
});

it("uses the release Bun for all CI dependency installation and runtime checks", () => {
    for (const [name, job] of Object.entries(config.jobs)) {
        const bun = setup(job, "oven-sh/setup-bun");
        if (bun) assert.equal(bun.with["bun-version"], BUN_VERSION, name);
    }
});

it("tests the exact Node floor and current Node on both native transport platforms", () => {
    const job = config.jobs.transport;
    assert.deepEqual(job.strategy.matrix.node, [MINIMUM_NODE, "22"]);
    assert.equal(setup(job, "actions/setup-node").with["node-version"], "${{ matrix.node }}");
    const steps = job.steps;
    const generation = steps.findIndex(step => step.run?.includes("generate-integrations"));
    const production = steps.findIndex(step => step.run?.includes("outboundHttpRuntime.test.js"));
    assert.ok(generation >= 0 && generation < production, "generate registries before production imports");
    assert.match(steps[generation].run, /generate-migrations/);
    for (const name of ["smtpIntegration", "emailSends", "digestSends"])
        assert.ok(steps[production].run.includes(`${name}.test.js`), name);
    assert.ok(steps.some(step => step.run === "bun install --frozen-lockfile"));
});

it("qualifies the real SQLite lifecycle on native and compiled Bun in CI", () => {
    const commands = config.jobs.transport.steps.map(step => step.run ?? "").join("\n");
    const fixture = "./tests/fixtures/bun-sqlite-lifecycle/run.mjs";
    assert.ok(commands.includes(`bun ${fixture}`));
    assert.ok(commands.includes(`bun build --compile --external pg-hstore --external pg ${fixture}`));
    assert.match(commands, /& \$sqliteProbe/);
});

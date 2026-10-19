import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {collectActionPins, pinned} from "../helpers/actionPins.js";

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const OTHER_SHA = "0".repeat(40);
const workflowText = (...uses) => `jobs:\n  build:\n    steps:\n${uses.map((ref) => `      - uses: ${ref}\n`).join("")}`;

describe("collectActionPins", () => {
    it("returns the one SHA each external action is pinned to across workflows", () => {
        const pins = collectActionPins([
            ["a.yml", workflowText(`actions/checkout@${CHECKOUT_SHA}`, "./.github/actions/local")],
            ["b.yml", workflowText(`actions/checkout@${CHECKOUT_SHA}`, `oven-sh/setup-bun@${OTHER_SHA}`)]
        ]);
        assert.deepEqual(Object.fromEntries(pins), {
            "actions/checkout": CHECKOUT_SHA,
            "oven-sh/setup-bun": OTHER_SHA
        });
    });

    it("ignores local actions and reusable workflows of this repository", () => {
        const text = "jobs:\n  release:\n    uses: ./.github/workflows/build.yml\n  test:\n    steps:\n      - run: echo\n";
        assert.equal(collectActionPins([["c.yml", text]]).size, 0);
    });

    it("names both workflows when one action drifts to a second SHA", () => {
        assert.throws(() => collectActionPins([
            ["a.yml", workflowText(`actions/checkout@${CHECKOUT_SHA}`)],
            ["b.yml", workflowText(`actions/checkout@${OTHER_SHA}`)]
        ]), /actions\/checkout.*a\.yml.*b\.yml/s);
    });

    it("rejects an external action that is not pinned to a full commit SHA", () => {
        assert.throws(() => collectActionPins([["a.yml", workflowText("actions/checkout@v4")]]),
            /actions\/checkout@v4 in a\.yml/);
    });
});

describe("pinned", () => {
    it("names an action at the SHA the repository's workflows use", () => {
        assert.match(pinned("actions/checkout"), /^actions\/checkout@[a-f0-9]{40}$/);
    });

    it("refuses an action no workflow uses", () => {
        assert.throws(() => pinned("example/not-used"), /example\/not-used/);
    });
});

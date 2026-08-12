import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    configOutcome, failureOutcome, isRemoteNode
} from "../../client/src/common/contexts/Config/configOutcome.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const context = fs.readFileSync(path.join(CLIENT_SRC,
    "common/contexts/Config/ConfigContext.jsx"), "utf8");

const VIEW_CONFIG = {viewMode: true, provider: "ookla"};
const ADMIN_CONFIG = {viewMode: false, provider: "ookla"};

/**
 * What the config provider does with the answer it just got.
 *
 * This was a ternary: navigate to /nodes, *or* store the config. On a
 * read-access instance with a remote node selected it took the first branch,
 * so setConfig was never called and `config` stayed {} - and ConfigProvider
 * sits above the router outlet, so it stayed {} for the rest of the session
 * rather than only until the navigation finished. Every consumer reads it:
 * HeaderComponent and NodeProvider both bail on an empty config, so the header
 * never rendered and the node list was never fetched, on the one page the
 * redirect had just sent the visitor to.
 *
 * Storing the answer and deciding where to be are two answers, not one.
 */
describe("isRemoteNode", () => {
    it("treats an unset node as local", () => {
        assert.equal(isRemoteNode(null), false);
    });

    it("treats the instance's own node as local", () => {
        assert.equal(isRemoteNode("0"), false);
    });

    it("treats any other stored node as remote", () => {
        assert.equal(isRemoteNode("1"), true);
        assert.equal(isRemoteNode("42"), true);
    });
});

describe("configOutcome", () => {
    it("always carries the config, redirect or not", () => {
        assert.deepEqual(configOutcome(VIEW_CONFIG, "1").config, VIEW_CONFIG);
        assert.deepEqual(configOutcome(VIEW_CONFIG, "0").config, VIEW_CONFIG);
        assert.deepEqual(configOutcome(ADMIN_CONFIG, "1").config, ADMIN_CONFIG);
    });

    it("redirects a view-mode instance that is pointed at a remote node", () => {
        assert.equal(configOutcome(VIEW_CONFIG, "1").redirectToNodes, true);
    });

    it("stays put when the instance is not in view mode", () => {
        assert.equal(configOutcome(ADMIN_CONFIG, "1").redirectToNodes, false);
    });

    it("stays put when the selected node is this instance", () => {
        assert.equal(configOutcome(VIEW_CONFIG, "0").redirectToNodes, false);
        assert.equal(configOutcome(VIEW_CONFIG, null).redirectToNodes, false);
    });

    /**
     * The redirect is the whole reason this bug went unnoticed - the page it
     * lands on is the one that needs the config most, and it is a different
     * page from the one the operator was looking at.
     */
    it("still stores the config on the redirecting path", () => {
        const outcome = configOutcome(VIEW_CONFIG, "1");

        assert.equal(outcome.redirectToNodes, true);
        assert.notEqual(outcome.config, undefined,
            "the redirect swallowed the config, leaving every consumer with {}");
        assert.equal(outcome.config.viewMode, true);
    });
});

describe("failureOutcome", () => {
    it("sends a visitor with a remote node selected to the node list", () => {
        assert.equal(failureOutcome("1").redirectToNodes, true);
    });

    it("shows the error to a visitor looking at this instance", () => {
        assert.equal(failureOutcome("0").redirectToNodes, false);
        assert.equal(failureOutcome(null).redirectToNodes, false);
    });
});

describe("the config context", () => {
    it("routes its answer through the shared decision", () => {
        assert.match(context, /configOutcome/,
            "the context still decides for itself and can drift from what is tested here");
    });

    /**
     * `result` is a fresh object out of JSON.parse on every reload, so this
     * reference comparison was true every single time - it read as a guard
     * against redundant renders and guarded nothing.
     */
    it("no longer pretends to compare the new config against the old", () => {
        assert.doesNotMatch(context, /config\s*!==\s*result/);
    });
});

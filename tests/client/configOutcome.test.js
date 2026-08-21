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

    /**
     * A refusal is not a node that has gone away, and the difference is the
     * whole recovery.
     *
     * The redirect was written for a node that cannot be reached: sending the
     * visitor to the list is the only useful place to be. But every request
     * while a remote node is selected travels through the parent, so the
     * *parent's* own session expiring refuses them too - and that answered the
     * same redirect, which pre-empted the password prompt. The node list then
     * 401s as well and swallows it, so the visitor lands on an empty page with
     * no error, no prompt, and a reload that returns them to it.
     *
     * A credential failure belongs in front of a password box wherever it was
     * raised.
     */
    it("asks for the credential rather than redirecting when the refusal wants one", () => {
        assert.equal(failureOutcome("1", {credential: true}).redirectToNodes, false,
            "a session expiring while a node is selected strands the visitor on the node list");
    });

    it("still redirects when the node itself could not be reached", () => {
        assert.equal(failureOutcome("1", {credential: false}).redirectToNodes, true);
        assert.equal(failureOutcome("1", undefined).redirectToNodes, true);
    });

    // On this instance there is nowhere to redirect to either way.
    it("shows a credential failure on this instance as before", () => {
        assert.equal(failureOutcome("0", {credential: true}).redirectToNodes, false);
    });

    /**
     * And the other credential failure, which the one above cannot be told from
     * without asking who refused.
     *
     * Rotate the password on a child node and the parent proxies its 401 back
     * verbatim. That is a credential failure, so the rule above keeps the
     * visitor where they are and opens the password box - and login() posts to
     * this instance's /api/session, which is not the credential that was
     * refused. The parent accepts its own password, the page reloads, the child
     * refuses again, and the box comes back: a loop in which the right password
     * is called right and nothing changes. The only thing that fixes it is
     * updatePassword() on the node list, so that is where this one belongs.
     *
     * The parent marks a refusal it relayed rather than raised - see
     * NODE_REFUSAL_HEADER - because the two are identical from here otherwise.
     */
    it("sends a node's own refusal to the list, where the password can be changed", () => {
        assert.equal(failureOutcome("1", {credential: true, node: true}).redirectToNodes, true,
            "a rotated node password loops the parent's password prompt for ever");
    });

    // The same refusal about this instance still has nowhere to go.
    it("keeps a node refusal on this instance where it is", () => {
        assert.equal(failureOutcome("0", {credential: true, node: true}).redirectToNodes, false);
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

    // The refusal it throws has to carry who refused, or failureOutcome has
    // nothing to decide on and the loop above comes back.
    it("records whether the node or this instance refused", () => {
        assert.match(context, /NODE_REFUSAL_HEADER/,
            "every 401 looks like this instance's own, so a node's refusal reopens the wrong prompt");
        assert.match(context, /node:\s*res\.headers\.get\(/,
            "the refusal travels without saying who raised it");
    });
});

/**
 * And the two ends of that header agree on its name.
 *
 * It is a string in two files that never import each other; the client reading
 * a header the server does not set is indistinguishable, from the client, from
 * a node that did not refuse - which is the loop, silently back.
 */
describe("the node refusal header", () => {
    const SERVER_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "server");
    const read = (file) => fs.readFileSync(path.join(SERVER_ROOT, file), "utf8");

    const nameIn = (source) => source.match(/NODE_REFUSAL_HEADER\s*=\s*"([^"]+)"/)?.[1];

    it("is spelled the same on both sides", () => {
        const server = nameIn(read("util/authOutcome.js"));
        const client = nameIn(fs.readFileSync(path.join(CLIENT_SRC, "common/utils/AuthOutcome.js"), "utf8"));

        assert.ok(server, "the server no longer names the header");
        assert.equal(client, server, "the client reads a header the server does not set");
    });

    it("is set on a refusal the proxy relayed", () => {
        assert.match(read("controller/node.js"), /NODE_REFUSAL_HEADER/,
            "the parent relays a node's 401 without marking it as the node's");
    });
});

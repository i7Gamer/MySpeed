import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    clearTestOutcome, suppressesKeepAlive, testIsFailing, triggerEvent
} from "../../server/controller/integrations.js";
import setupHealthChecks from "../../server/integrations/healthChecks.js";
import setupWebhook from "../../server/integrations/webhook.js";
import setupDiscord from "../../server/integrations/discord.js";
import setupInflux from "../../server/integrations/influxdb.js";

/** The definition a module declares, without registering anything that could fire. */
const definitionOf = (setup) => setup(() => undefined);

const HEALTH_CHECKS = definitionOf(setupHealthChecks);

beforeEach(() => {
    clearTestOutcome();
});

/**
 * A keep-alive must not undo what the failure ping just said.
 *
 * healthChecks pings four things: the root URL on a finished test, /start when
 * one begins, /fail when one fails, and the root URL again every minute as a
 * keep-alive. The root URL is healthchecks.io's *success* endpoint - so within
 * sixty seconds of a speedtest failing, the keep-alive reported the check up
 * again and the failure was gone. The one notification the operator most wants
 * was delivered and then withdrawn, by the integration itself, silently.
 *
 * The suppression is declared by the module rather than decided by name here,
 * the same way `notifier: true` is: which integrations behave which way is a
 * fact about the whole set, and no single module can notice when it changes.
 * Only a module whose keep-alive *asserts health* needs it - webhook's
 * send_alive is a heartbeat carrying a payload and says nothing about the line.
 */
describe("suppressesKeepAlive", () => {
    it("holds the keep-alive back while the last test is a failure", () => {
        assert.equal(suppressesKeepAlive("minutePassed", HEALTH_CHECKS, true), true);
    });

    it("lets it through once a test has succeeded", () => {
        assert.equal(suppressesKeepAlive("minutePassed", HEALTH_CHECKS, false), false);
    });

    /**
     * The failure ping itself is never held back, nor is the success one - only
     * the periodic assertion that nothing is wrong. Withholding testFinished
     * would leave the check down after the line recovered, which is the same
     * fault in the other direction.
     */
    for (const event of ["testFinished", "testFailed", "testStarted"])
        it(`never withholds ${event}`, () => {
            assert.equal(suppressesKeepAlive(event, HEALTH_CHECKS, true), false);
        });

    it("leaves a module that did not ask for it alone", () => {
        for (const setup of [setupWebhook, setupDiscord, setupInflux])
            assert.equal(suppressesKeepAlive("minutePassed", definitionOf(setup), true), false);
    });

    // An unknown or removed integration is not silently opted in.
    it("treats a missing definition as not asking for it", () => {
        assert.equal(suppressesKeepAlive("minutePassed", undefined, true), false);
        assert.equal(suppressesKeepAlive("minutePassed", {}, true), false);
    });
});

describe("the declared opt-in", () => {
    it("is on healthChecks, whose keep-alive is a success ping", () => {
        assert.equal(HEALTH_CHECKS.aliveMeansHealthy, true);
    });

    it("is not on the modules whose keep-alive claims nothing", () => {
        for (const setup of [setupWebhook, setupDiscord, setupInflux])
            assert.notEqual(definitionOf(setup).aliveMeansHealthy, true);
    });
});

/**
 * And the outcome the decision is made against.
 *
 * One instance runs one speedtest, so this is a fact about the instance rather
 * than about any integration - which is why it is recorded once here instead of
 * per row. It is recorded before the fan-out decides whether anything is
 * listening: an instance with no healthChecks configured still has to know the
 * last test failed, in case one is added before the next test runs.
 */
describe("the last test outcome", () => {
    it("starts out not failing", () => {
        assert.equal(testIsFailing(), false);
    });

    it("is set by a failure", async () => {
        await triggerEvent("testFailed", {error: "no route to host"});

        assert.equal(testIsFailing(), true);
    });

    it("is cleared by the next success", async () => {
        await triggerEvent("testFailed", {error: "no route to host"});
        await triggerEvent("testFinished", {ping: 12});

        assert.equal(testIsFailing(), false);
    });

    // A run beginning says nothing about how it will end, and the keep-alive
    // has to stay held back across it or the failure resurfaces mid-retry.
    it("is not disturbed by a test starting", async () => {
        await triggerEvent("testFailed", {error: "boom"});
        await triggerEvent("testStarted");

        assert.equal(testIsFailing(), true);
    });

    it("is not disturbed by the keep-alive itself", async () => {
        await triggerEvent("testFailed", {error: "boom"});
        await triggerEvent("minutePassed", {});

        assert.equal(testIsFailing(), true);
    });
});

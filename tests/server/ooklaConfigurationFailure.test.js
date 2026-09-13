import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {parseCliOutput, isRateLimitMessage} from "../../server/util/providers/cliOutput.js";
import {readSource} from "../helpers/source.js";

// Issue #56: replay public CLI output only. No provider process or network call.
const CONFIGURATION_FAILURE = [
    "[2026-09-13 14:06:56.976] [error] Configuration - Cannot retrieve configuration document (503)",
    "[2026-09-13 14:06:56.988] [error] ConfigurationError - Could not retrieve or read configuration (Configuration)",
    "[2026-09-13 14:06:56.989] [error] ConfigurationError - Could not retrieve or read configuration (Configuration)"
].join("\n");
const ERROR_LOG = JSON.stringify({
    type: "log", timestamp: "2026-09-13T11:06:56Z",
    message: "Configuration - Could not retrieve or read configuration (ConfigurationError)", level: "error"
});
const MEASUREMENT = JSON.stringify({type: "result", ping: {latency: 12},
    download: {bandwidth: 1000}, upload: {bandwidth: 500}});

describe("Ookla configuration-service HTTP 503 (#56)", () => {
    it("preserves the reported raw configuration failure for diagnosis", () => {
        assert.deepEqual(parseCliOutput("ookla", ERROR_LOG, CONFIGURATION_FAILURE), {error: CONFIGURATION_FAILURE});
    });

    it("handles the combined stderr output in the issue", () => {
        const raw = `${CONFIGURATION_FAILURE}\n${ERROR_LOG}`;
        assert.equal(parseCliOutput("ookla", "", raw).error, raw);
    });

    it("preserves the same diagnostic in an explicit JSON error field", () => {
        for (const error of [CONFIGURATION_FAILURE, {message: CONFIGURATION_FAILURE}])
            assert.equal(parseCliOutput("ookla", JSON.stringify({error}), "").error, CONFIGURATION_FAILURE);
    });

    it("does not turn service unavailability into rate-limit backoff", () => {
        const {error} = parseCliOutput("ookla", ERROR_LOG, CONFIGURATION_FAILURE);
        assert.equal(isRateLimitMessage(error), false);
        assert.equal(isRateLimitMessage(CONFIGURATION_FAILURE), false);
    });

    it("retains a real successful result despite configuration noise", () => {
        const result = parseCliOutput("ookla", `${ERROR_LOG}\n${MEASUREMENT}`, CONFIGURATION_FAILURE);
        assert.deepEqual(result, JSON.parse(MEASUREMENT));
    });

    it("does not label another provider's error as an Ookla outage", () => {
        for (const provider of ["libre", "cloudflare", "iperf3"])
            assert.equal(parseCliOutput(provider, "", CONFIGURATION_FAILURE).error, CONFIGURATION_FAILURE);
    });

    it("requires the specific configuration error, not an incidental 503", () => {
        for (const error of [
            "Server 503 did not respond", "download failed (503)",
            "Configuration - Cannot retrieve configuration document (403)",
            "Configuration - Cannot retrieve configuration document (5030)",
            "ConfigurationError - Could not retrieve or read configuration (Configuration)"
        ]) assert.equal(parseCliOutput("ookla", "", error).error, error);
    });

    it("keeps actual rate-limit handling distinct", () => {
        assert.equal(isRateLimitMessage(parseCliOutput("ookla", "", "Too many requests").error), true);
    });

    it("does not recommend reconnecting or restarting for every provider failure", () => {
        const source = readSource("server/tasks/speedtest.js");
        assert.doesNotMatch(source, /Please try reconnecting to the internet or restarting the software/);
        assert.match(source, /Test #\$\{testResult\.id\} was not executed successfully:.*\+ message/);
    });
});

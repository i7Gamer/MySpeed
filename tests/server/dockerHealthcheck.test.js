import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readSource } from "../helpers/source.js";

/**
 * The address the image's HEALTHCHECK calls.
 *
 * It always called 127.0.0.1, but SERVER_HOST binds the listener to one
 * address only (server/config/bind.js) - so a container told to listen on its
 * LAN address, or on ::1, answered nothing on 127.0.0.1 and was reported
 * unhealthy for its whole life while serving perfectly well, and anything
 * waiting on `service_healthy` never started.
 *
 * The command is run, not matched: sh with `wget` replaced by a function that
 * prints the URL it was given.
 */
const dockerfile = readSource("Dockerfile");
const healthcheck = /^HEALTHCHECK[^\n]*\\\n\s+CMD (.+)$/m.exec(dockerfile);

const urlFor = (env) => {
    const result = spawnSync("sh", ["-c", `wget() { printf '%s' "$2"; }; ${healthcheck[1]}`], {
        env: {PATH: process.env.PATH, ...env}, encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
};

describe("the Docker healthcheck", () => {
    it("is a shell-form command this test can run", () => {
        assert.ok(healthcheck, "the HEALTHCHECK no longer has the shape this test reads");
    });

    it("calls loopback when no bind address is set", () => {
        assert.equal(urlFor({}), "http://127.0.0.1:5216/api/health");
    });

    it("calls the address the listener is bound to", () => {
        assert.equal(urlFor({SERVER_HOST: "192.168.1.5"}), "http://192.168.1.5:5216/api/health");
    });

    it("brackets an IPv6 bind address", () => {
        assert.equal(urlFor({SERVER_HOST: "::1"}), "http://[::1]:5216/api/health");
    });

    for (const wildcard of ["0.0.0.0", "::"])
        it(`calls loopback for the wildcard ${wildcard}`, () => {
            assert.equal(urlFor({SERVER_HOST: wildcard}), "http://127.0.0.1:5216/api/health");
        });

    it("keeps following SERVER_PORT", () => {
        assert.equal(urlFor({SERVER_HOST: "10.0.0.2", SERVER_PORT: "8080"}), "http://10.0.0.2:8080/api/health");
    });
});

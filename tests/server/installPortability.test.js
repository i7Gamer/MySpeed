import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The installer on a machine that is not the one it was written on.
 *
 * apt-get was called unconditionally, so on anything that is not
 * Debian-shaped the script staggered through "command not found" errors and
 * succeeded only if curl and wget happened to be preinstalled - and failed
 * half-way with no explanation if they were not. And two of its network calls
 * carried no deadline: the release lookup, and the ifconfig.me call that
 * prints the access address - which on an air-gapped host stalled the final
 * message of an otherwise finished install for as long as curl cares to wait.
 *
 * Deliberately not multi-distro support: the script targets Debian and says
 * so by using apt-get at all. What it owes everyone else is an honest message
 * instead of a broken half-install.
 */
const withoutComments = (source) => source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const install = withoutComments(readSource("scripts/install.sh"));

describe("the installer on a machine without apt-get", () => {
    it("asks whether apt-get exists before calling it", () => {
        assert.match(install, /command -v apt-get/,
            "apt-get is called blind, so any other distribution staggers through errors");
    });

    // Every call sits inside a guard, so none is at the start of a line.
    it("never calls it unguarded", () => {
        assert.doesNotMatch(install, /^apt-get /m,
            "an apt-get call sits at top level, outside any guard");
    });

    it("refuses honestly when a dependency is missing and nothing can install it", () => {
        assert.match(install, /command -v apt-get[^]*?exit 1/,
            "a machine that cannot install the missing dependency carries on into a broken install");
    });
});

describe("the installer's network calls", () => {
    it("gives every curl a deadline", () => {
        const curls = install.split("\n").filter((line) => line.includes("curl "));

        assert.ok(curls.length > 0, "the installer no longer uses curl at all");
        for (const line of curls)
            assert.match(line, /--max-time \d+/, `a curl carries no deadline: ${line.trim()}`);
    });

    it("gives the download a stall deadline", () => {
        const downloads = install.split("\n").filter((line) => line.includes("wget "));

        assert.ok(downloads.length > 0, "the installer no longer uses wget at all");
        for (const line of downloads)
            assert.match(line, /--timeout=\d+/, `a wget carries no stall deadline: ${line.trim()}`);
    });

    // The address is a convenience; a host that cannot reach ifconfig.me still
    // deserves its closing message, with a placeholder where the address goes.
    it("still prints the closing message when the address lookup fails", () => {
        assert.match(install, /ifconfig\.me[^)]*\|\|/,
            "a failed address lookup leaves a hole in the final message, or stalls it");
    });
});

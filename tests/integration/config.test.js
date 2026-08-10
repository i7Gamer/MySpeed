import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await setConfig(server.config, "password", "none");
    await setConfig(server.config, "passwordLevel", "none");
});

const validate = (key, value) => server.config.validateInput(key, value);
const rejects = async (key, value) => assert.equal(typeof await validate(key, value), "string",
    `${key}=${JSON.stringify(value)} was accepted`);
const accepts = async (key, value) => {
    const result = await validate(key, value);
    assert.notEqual(typeof result, "string", `${key}=${JSON.stringify(value)} was rejected with "${result}"`);
    return result.value;
};

describe("validateInput", () => {
    it("rejects an empty value", async () => {
        await rejects("ping", "");
        await rejects("ping", undefined);
    });

    it("rejects an unknown key", async () => {
        await rejects("thereIsNoSuchKey", "5");
    });

    describe("thresholds", () => {
        it("accepts a decimal download threshold", async () => {
            assert.equal(await accepts("download", "123.45"), "123.45");
        });

        it("rejects a non-numeric threshold", async () => {
            await rejects("download", "fast");
            await rejects("upload", "50mb");
        });

        // The column is an integer, so the fractional part is dropped rather
        // than silently rounded by the database.
        it("truncates a fractional ping to whole milliseconds", async () => {
            assert.equal(await accepts("ping", "25.9"), "25");
        });
    });

    describe("retentionDays", () => {
        it("keeps a value inside the allowed range", async () => {
            assert.equal(await accepts("retentionDays", "30"), "30");
        });

        it("normalises anything at or below zero to unlimited", async () => {
            assert.equal(await accepts("retentionDays", "0"), "0");
            assert.equal(await accepts("retentionDays", "-1"), "0");
        });

        it("rejects a value above the maximum", async () => {
            await rejects("retentionDays", "10001");
        });

        it("accepts exactly the maximum", async () => {
            assert.equal(await accepts("retentionDays", "10000"), "10000");
        });

        it("rejects a non-numeric retention", async () => {
            await rejects("retentionDays", "forever");
            await rejects("retentionDays", "5-3");
        });
    });

    describe("provider", () => {
        it("accepts the three supported providers", async () => {
            for (const provider of ["ookla", "libre", "cloudflare"])
                assert.equal(await accepts("provider", provider), provider);
        });

        it("rejects anything else", async () => {
            await rejects("provider", "speedtest.net");
        });
    });

    describe("server ids and urls", () => {
        it("accepts a numeric server id or the unset sentinel", async () => {
            assert.equal(await accepts("ooklaId", "1234"), "1234");
            assert.equal(await accepts("libreId", "none"), "none");
        });

        it("rejects a non-numeric server id", async () => {
            await rejects("ooklaId", "frankfurt");
        });

        it("accepts a valid libre url", async () => {
            assert.equal(await accepts("libreUrl", "https://speed.example.net"), "https://speed.example.net");
        });

        it("rejects a malformed libre url", async () => {
            await rejects("libreUrl", "not a url");
        });
    });

    describe("cron", () => {
        it("accepts a valid expression", async () => {
            assert.equal(await accepts("cron", "0 * * * *"), "0 * * * *");
        });

        it("rejects a malformed expression", async () => {
            await rejects("cron", "every hour please");
            await rejects("cron", "99 * * * *");
        });
    });

    describe("flags", () => {
        it("accepts only true or false for scheduleOffset", async () => {
            assert.equal(await accepts("scheduleOffset", "false"), "false");
            await rejects("scheduleOffset", "yes");
        });

        it("accepts only none or read for passwordLevel", async () => {
            assert.equal(await accepts("passwordLevel", "read"), "read");
            await rejects("passwordLevel", "write");
        });

        it("rejects an interface that does not exist on this host", async () => {
            await rejects("interface", "eth99");
        });
    });

    describe("password", () => {
        it("stores a bcrypt hash rather than the password", async () => {
            const stored = await accepts("password", "Hunter2!");

            assert.notEqual(stored, "Hunter2!");
            assert.match(stored, /^\$2[aby]\$/);
        });

        /**
         * Regression: "none" is the stored sentinel for "no password
         * configured". validateInput used to skip hashing for it, storing the
         * literal string, which password.js reads as "unprotected" - so a user
         * who chose "none" as their password silently left the instance open
         * while the API answered "successfully updated".
         */
        it("refuses the no-password sentinel as a chosen password", async () => {
            await rejects("password", "none");
        });

        /**
         * The admin credential of an instance that may face the open internet.
         * A single character used to be accepted; now a chosen password needs
         * 8+ characters, both cases, and a number or special character. Only a
         * *chosen* password: a backup restores its hash verbatim, so existing
         * installs keep working.
         */
        describe("the password policy", () => {
            // The refusal itself, so the tests can assert it names the rule.
            const refusal = async (value) => {
                const result = await validate("password", value);
                assert.equal(typeof result, "string", `${JSON.stringify(value)} was accepted`);
                return result;
            };

            it("refuses fewer than 8 characters", async () => {
                assert.match(await refusal("Sh0rt!"), /at least 8 characters/);
            });

            it("refuses a single case", async () => {
                assert.match(await refusal("alllower1!"), /lower and upper case/);
                assert.match(await refusal("ALLUPPER1!"), /lower and upper case/);
            });

            it("refuses letters alone", async () => {
                assert.match(await refusal("OnlyLetters"), /number or a special character/);
            });

            it("accepts a special character in place of a number", async () => {
                assert.match(await accepts("password", "Pa ss Wörd"), /^\$2[aby]\$/);
            });
        });
    });
});

describe("config routes", () => {
    const patchPassword = (value) => api(server.baseUrl, "/config/password", {
        method: "PATCH",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({value})
    });

    const isProtected = async () => (await api(server.baseUrl, "/speedtests?limit=1")).status === 401;

    it("PATCH sets a password", async () => {
        assert.equal((await patchPassword("Hunter2!")).status, 200);
        assert.equal(await isProtected(), true);
    });

    it("PATCH refuses to leave the instance open via the sentinel", async () => {
        const {status} = await patchPassword("none");

        assert.equal(status, 400);
        assert.equal(await isProtected(), false, "the instance was left unprotected");
    });

    it("PATCH refuses a password below the policy, and says which rule", async () => {
        const {status, body} = await patchPassword("weak");

        assert.equal(status, 400);
        assert.match(body.message, /at least 8 characters/);
        assert.equal(await isProtected(), false);
    });

    it("DELETE clears the password", async () => {
        await patchPassword("Hunter2!");

        const {status} = await api(server.baseUrl, "/config/password", {
            method: "DELETE", headers: {"x-password": "Hunter2!"}
        });

        assert.equal(status, 200);
        assert.equal(await isProtected(), false);
    });

    it("DELETE is itself password protected", async () => {
        await patchPassword("Hunter2!");

        assert.equal((await api(server.baseUrl, "/config/password", {method: "DELETE"})).status, 401);
        assert.equal(await isProtected(), true);
    });

    it("never exposes the password through GET /api/config", async () => {
        await patchPassword("Hunter2!");

        const {body} = await api(server.baseUrl, "/config", {headers: {"x-password": "Hunter2!"}});
        assert.equal(body.password, undefined);
        assert.doesNotMatch(JSON.stringify(body), /Hunter2!|\$2[aby]\$/);
    });
});

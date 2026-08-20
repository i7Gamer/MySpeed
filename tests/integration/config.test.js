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

        // Like its two siblings. The value lands in the config table's string
        // column - there is no integer column to respect - and the pings it is
        // compared against have been DOUBLE since 0010, the recommended ping
        // since 0012. Cutting it at the dot turned "use recommended" on a
        // fibre line into a stored threshold of 0, and ".5" into the empty
        // string - see thresholdFraction.test.js.
        it("keeps a fractional ping whole", async () => {
            assert.equal(await accepts("ping", "25.9"), "25.9");
        });

        /**
         * Anchored, like retentionDays below it - and for the reason stated
         * there. A bare negated class asks only whether every character is a
         * digit or a dot, so "1.2.3", ".." and "." are all numbers to it.
         *
         * What that costs is invisible rather than loud: nothing on the server
         * reads these three keys, so the value is stored with a 200 and the
         * client is left with it. `Number("1.2.3")` is NaN, and the guard in
         * getIconBySpeed answers neutral for a threshold it cannot read - so
         * every speed on the page goes grey and stays grey, with nothing on
         * screen saying which value did it. "." is worse still: the ping branch
         * splits on the dot and stores the empty string.
         */
        it("rejects a value that is only digits and dots", async () => {
            for (const key of ["ping", "download", "upload"])
                for (const bad of ["1.2.3", "..", "."])
                    await rejects(key, bad);
        });

        /**
         * And accepts every shape that is a number, which is wider than the
         * three above are narrow.
         *
         * ".5" and "1." both read as numbers - 0.5 and 1 - and both were
         * accepted by the check this replaced, so an instance can be holding one
         * right now. That matters more than the typing: importConfig runs every
         * stored key back through this validator and abandons the whole restore
         * on the first refusal, so a threshold saved as ".5" would take the
         * nodes and the integrations down with it, naming no key.
         */
        it("still accepts every shape that is a number", async () => {
            assert.equal(await accepts("download", "250"), "250");
            assert.equal(await accepts("upload", "12.5"), "12.5");
            assert.equal(await accepts("download", ".5"), ".5");
            assert.equal(await accepts("upload", "1."), "1.");
        });
    });

    /**
     * The daily window in which no scheduled test runs. Both ends are ordinary
     * configuration values, so both go through here - and a value this refuses
     * is one the scheduler would silently read as "no window at all".
     */
    describe("quiet hours", () => {
        for (const key of ["quietHoursStart", "quietHoursEnd"]) {
            it(`accepts a time of day for ${key}`, async () => {
                assert.equal(await accepts(key, "23:00"), "23:00");
                assert.equal(await accepts(key, "08:30"), "08:30");
            });

            it(`accepts the off sentinel for ${key}`, async () => {
                assert.equal(await accepts(key, "none"), "none");
            });

            it(`rejects a time that is not one for ${key}`, async () => {
                for (const bad of ["24:00", "12:60", "noon", "12", "1200", "-1:00"])
                    await rejects(key, bad);
            });
        }
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

        /**
         * The column is a STRING and every reader compares against the literal
         * "true", so whatever is accepted has to be stored in that spelling.
         *
         * Accepting a JSON boolean without normalising it stored sqlite's
         * rendering of a bound boolean - the text "1.0" - which no reader
         * recognises: the offset silently stayed off, the API answered 200, and
         * the dialog toggle showed OFF. It also poisoned every later config
         * export, because re-importing "1.0" fails validation and refuses the
         * whole restore. A loud 400 was better than that, so the widening only
         * pays for itself if the value is normalised on the way in.
         */
        it("stores a boolean true as the string every reader compares against", async () => {
            assert.equal(await accepts("scheduleOffset", true), "true");
        });

        it("stores a boolean false the same way", async () => {
            assert.equal(await accepts("scheduleOffset", false), "false");
        });

        it("still refuses a value that is neither", async () => {
            await rejects("scheduleOffset", 1);
            await rejects("scheduleOffset", "1.0");
        });

        it("accepts only none or read for passwordLevel", async () => {
            assert.equal(await accepts("passwordLevel", "read"), "read");
            await rejects("passwordLevel", "write");
        });

        it("rejects an interface that does not exist on this host", async () => {
            await rejects("interface", "eth99");
        });

        /**
         * "Does this key exist" was asked with configDefaults[key], which also
         * answers for everything on Object.prototype - PATCH /api/config/toString
         * walked past the check and died as a 500 in the update instead of the
         * 400 an unknown key earns.
         */
        it("refuses prototype keys as unknown rather than erroring on them", async () => {
            for (const key of ["toString", "__proto__", "constructor", "hasOwnProperty"])
                await rejects(key, "x");
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

        /**
         * A body value that is not a string at all.
         *
         * The policy was checked against `value.toString()` while the hash was
         * taken of the raw value, so anything whose string form happens to
         * satisfy the rules reached bcrypt - and bcryptjs refuses a non-string
         * outright. `{"value": {}}` stringifies to "[object Object]": fifteen
         * characters, both cases, a special character, every rule cleared. The
         * throw escaped the controller instead of returning the 400 that every
         * other malformed key earns.
         */
        describe("a value that is not a string", () => {
            const REFUSED = {
                "an object": {},
                "an array": ["Password1!"],
                "a number": 12345678,
                "a boolean": true
            };

            for (const [name, value] of Object.entries(REFUSED)) {
                it(`refuses ${name} rather than throwing`, async () => {
                    const result = await validate("password", value);

                    assert.equal(typeof result, "string",
                        `${name} was accepted as a password`);
                });
            }

            // The refusal says what is wrong with it, rather than reporting a
            // policy failure for a value that never had a chance to meet one.
            it("says the password has to be text", async () => {
                assert.match(await validate("password", {}), /text|string/i);
            });

            // And an ordinary string still goes through, hashed.
            it("still hashes a password that is a string", async () => {
                assert.match(await accepts("password", "Hunter2!"), /^\$2[aby]\$/);
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

/**
 * What the PATCH route reads out of validateInput, pinned.
 *
 * This is a contract, not a bug that shipped. The route asks whether the answer
 * is a string; it used to ask whether the answer had exactly one key, which for
 * a refusal is its character count - and every refusal validateInput writes
 * today is a whole sentence, so the two questions have always agreed. A refusal
 * of a single character would not have: it would have counted as one key,
 * walked past the guard and been written through as `value.value`, which is
 * undefined for a string. Nothing here reproduces that, because no input can
 * reach it. What is pinned is the shape both sides rely on, so a later refusal
 * message or a second key on the acceptance cannot quietly turn a refusal into
 * a write.
 */
describe("the validateInput contract the PATCH route reads", () => {
    // One key per kind of check validateInput makes, each with a value it takes
    // and one it turns down. `interface` is left out: which names it accepts
    // depends on the adapters of whatever host runs the tests.
    const CONTRACT_CASES = [
        {key: "download", accepted: "250", refused: "fast"},
        {key: "ping", accepted: "25.9", refused: "soon"},
        {key: "retentionDays", accepted: "30", refused: "forever"},
        {key: "provider", accepted: "libre", refused: "speedtest.net"},
        {key: "cron", accepted: "0 * * * *", refused: "every hour please"},
        {key: "scheduleOffset", accepted: "false", refused: "yes"},
        {key: "passwordLevel", accepted: "read", refused: "write"},
        {key: "ooklaId", accepted: "1234", refused: "frankfurt"},
        {key: "libreUrl", accepted: "https://speed.example.net", refused: "not a url"},
        {key: "password", accepted: "Hunter2!", refused: "none"}
    ];

    const patch = (key, value) => api(server.baseUrl, `/config/${key}`, {
        method: "PATCH",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({value})
    });

    // Read back the way a client reads it, so a value written as undefined
    // shows up here instead of being taken on the controller's word.
    const stored = async (key) => (await api(server.baseUrl, "/config")).body[key];

    it("refuses with a string and accepts with an object carrying only `value`", async () => {
        for (const {key, accepted, refused} of CONTRACT_CASES) {
            assert.equal(typeof await validate(key, refused), "string",
                `${key} refused ${JSON.stringify(refused)} with something other than a message`);

            const result = await validate(key, accepted);

            assert.equal(typeof result, "object", `${key} accepted ${JSON.stringify(accepted)} without an object`);
            assert.deepEqual(Object.keys(result), ["value"], `${key} accepted with more than the value`);
            assert.notEqual(result.value, undefined, `${key} accepted with no value to write`);
        }

        // The two refusals that belong to no key in particular.
        assert.equal(typeof await validate("thereIsNoSuchKey", "5"), "string");
        assert.equal(typeof await validate("download", ""), "string");
    });

    it("PATCH answers a refused value with 400, its message, and no write", async () => {
        const before = await stored("download");

        const {status, body} = await patch("download", "fast");

        assert.equal(status, 400);
        assert.equal(body.message, await validate("download", "fast"), "the refusal did not reach the client");
        assert.equal(await stored("download"), before, "a refused value was written anyway");
    });

    it("PATCH answers an accepted value with 200 and stores it", async () => {
        const {status} = await patch("download", "250");

        assert.equal(status, 200);
        assert.equal(await stored("download"), "250");
    });
});

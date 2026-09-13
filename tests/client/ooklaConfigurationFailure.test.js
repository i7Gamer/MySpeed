import {before, describe, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {describeError} from "@/common/components/TestDetails/utils/errors.js";
import {parseCliOutput} from "../../server/util/providers/cliOutput.js";
import {localeCodes, readLocale, readSource} from "../helpers/source.js";

const HTTP_STATUS = 503;
const SIGNATURE = `Configuration - Cannot retrieve configuration document (${HTTP_STATUS})`;
const GENERIC_CONFIGURATION = "ConfigurationError - Could not retrieve or read configuration (Configuration)";
const RAW_REPORT = `[2026-09-13 14:06:56.976] [error] ${SIGNATURE}\n`
    + `[2026-09-13 14:06:56.988] [error] ${GENERIC_CONFIGURATION}`;
const KEY = "ookla_configuration_unavailable";
const ENGLISH = "The speed-test configuration request returned HTTP 503 (service unavailable). Please try again later";

before(async () => {
    await i18n.init({lng: "en", resources: {en: {translation: readLocale("en")}}});
});

describe("configuration HTTP 503 explanation (#56)", () => {
    it("explains the actual report while retaining the raw provider output", () => {
        const parsed = parseCliOutput("ookla", "", RAW_REPORT);
        assert.equal(parsed.error, RAW_REPORT);
        assert.equal(describeError(parsed.error), ENGLISH);
    });

    it("recognises plain, timestamped CRLF and JSON-wrapped error text", () => {
        for (const error of [SIGNATURE, RAW_REPORT.replaceAll("\n", "\r\n"),
            JSON.stringify({type: "log", level: "error", message: SIGNATURE})])
            assert.equal(describeError(error), ENGLISH);
    });

    it("prefers the precise status explanation over the generic configuration line", () => {
        for (const error of [`${GENERIC_CONFIGURATION}\n${SIGNATURE}`, `${SIGNATURE}\n${GENERIC_CONFIGURATION}`])
            assert.equal(describeError(error), ENGLISH);
    });

    it("does not misclassify incidental numbers or other HTTP statuses", () => {
        for (const error of ["Server 503 did not respond", "Port 503", "download failed (503)",
            SIGNATURE.replace("(503)", "(403)"), SIGNATURE.replace("(503)", "(5030)")])
            assert.equal(describeError(error), null, error);
        assert.equal(describeError(GENERIC_CONFIGURATION), readLocale("en").errors.config);
    });

    it("does not change rate-limit or socket explanations", () => {
        assert.equal(describeError("Too many requests"), readLocale("en").errors.rate_limited);
        assert.equal(describeError("Cannot open socket"), readLocale("en").errors.cannot_open_socket);
    });

    it("provides a real translated explanation in every shipped locale", () => {
        for (const code of localeCodes()) {
            const value = readLocale(code).errors[KEY];
            assert.equal(typeof value, "string", code);
            assert.ok(value.trim().length > 0, code);
            assert.ok(value.includes(String(HTTP_STATUS)), code);
            assert.doesNotMatch(value, /[.!?。！？]$/u, `${code}: the detail panel supplies terminal punctuation`);
            if (code !== "en") assert.notEqual(value, ENGLISH, code);
        }
    });

    it("keeps the separate raw diagnostic in the detail panel", () => {
        const details = readSource("client/src/common/components/TestDetails/TestDetails.jsx");
        assert.ok(details.includes('<code className="detail-error-raw">{test.error}</code>'));
    });
});

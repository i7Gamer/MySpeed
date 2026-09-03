import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import { describeError } from "@/common/components/TestDetails/utils/errors.js";
import { RATE_LIMIT_MESSAGE } from "../../server/util/providers/cliOutput.js";
import { exitError, SHUTDOWN_STOP_MESSAGE } from "../../server/util/speedtest.js";
import { localeCodes, readLocale, readSource } from "../helpers/source.js";

const codes = localeCodes();

// The real English resource, not a stub. The point of this file is whether the
// phrases the server actually produces reach a translation, so a hand-written
// three-key resource - which is right for testing describeError's matching, and
// is what speedtestErrors.test.js uses - would answer a different question.
before(async () => {
    await i18n.init({lng: "en", resources: {en: {translation: readLocale("en")}}});
});

/**
 * Every failure the server can store, against the phrases the row can explain.
 *
 * describeError matches the stored output against a table of phrases and returns
 * null for anything else - deliberately, so the row shows a sentence and the
 * detail panel below it shows the unabridged text. The table was written from
 * the output of the three provider CLIs, and stayed that way while the server
 * grew failures of its own to report.
 *
 * Three fell through. The rate-limit refusal is the sharpest: cliOutput.js
 * normalises every provider's way of saying it onto one wording precisely so
 * that one entry would cover all of them, and no entry was ever made - so the
 * single failure the whole backoff subsystem exists to handle was the one that
 * rendered as "Unknown error". The other two are sentences MySpeed writes
 * itself in tasks/speedtest.js, which is how they were missed: nobody thinks to
 * register wording they wrote.
 *
 * Held here by importing the server's own constant rather than repeating it, so
 * a reworded refusal fails this instead of silently going unrecognised again.
 */
describe("the failures the server produces", () => {
    it("explains the rate-limit refusal the backoff normalises onto", () => {
        assert.notEqual(describeError(RATE_LIMIT_MESSAGE), null,
            "the one wording every provider's refusal is stored as has no entry in the phrase table");
    });

    it("explains it inside the larger output a provider prints around it", () => {
        assert.notEqual(describeError(`{"level":"error","message":"${RATE_LIMIT_MESSAGE}"}`), null);
    });

    /**
     * Read out of the task rather than listed here. A `throw new Error` added
     * beside these two is a new way for a test to fail, and listing them by hand
     * would mean this passes for exactly as long as somebody remembers to.
     */
    it("explains every failure the speedtest task authors itself", () => {
        const source = readSource("server/tasks/speedtest.js");

        // The static half of each template literal: `${mode} finished without
        // reporting any measurement` contributes " finished without reporting
        // any measurement". Fragments too short to be a phrase are skipped -
        // they are punctuation between two interpolations.
        const authored = [...source.matchAll(/throw new Error\(`([^`]+)`\)/g)]
            .map(([, template]) => template.split(/\$\{[^}]*}/).map((part) => part.trim()))
            .map((parts) => parts.filter((part) => part.length > 12));

        assert.ok(authored.length >= 2, `only found ${authored.length} authored throws to check`);

        const unexplained = authored
            .filter((parts) => !parts.some((part) => describeError(part) !== null))
            .map((parts) => parts.join(" … "));

        assert.deepEqual(unexplained, [],
            "these are sentences MySpeed writes and cannot then translate, so the row says 'Unknown error'");
    });

    /**
     * The two the *runner* writes, which that scan cannot reach: they live in
     * util/speedtest.js and neither is a `throw`. One is a constant, the other
     * is composed at the moment a child dies of a signal.
     *
     * Composed here rather than quoted, for the reason the constant exists at
     * all: the client matches on a substring of the server's sentence, so the
     * only pin worth having runs the real composition against the real table.
     * A `code === null` with no result is exactly what `close` reports for a
     * signal death.
     */
    it("explains a run that the server's own shutdown stopped", () => {
        assert.notEqual(describeError(SHUTDOWN_STOP_MESSAGE), null,
            "a docker stop landing on a run writes a sentence the row cannot translate");
    });

    it("explains a run that a signal from outside stopped", () => {
        assert.notEqual(describeError(exitError(null, {}, "SIGTERM")), null,
            "an OOM kill or a pkill writes a sentence the row cannot translate");
    });
});

/**
 * The bare label and the one that introduces the raw output are two strings.
 *
 * They were one, carrying a colon, because the detail panel appended the output
 * after it. The overview row appends nothing - so it rendered "Unknown error:"
 * and stopped, a sentence ending on punctuation that promises something more, in
 * all fifteen locales. French made it worse by spacing the colon correctly.
 */
describe("the unknown-error label", () => {
    it("does not end on punctuation, in any locale", () => {
        const dangling = codes
            .filter((code) => /[:：]\s*$/.test(readLocale(code).test?.unknown_error ?? ""))
            .map((code) => `${code}: ${readLocale(code).test.unknown_error}`);

        assert.deepEqual(dangling, [],
            "the overview row renders this alone, so a trailing colon has nothing after it");
    });

    it("has a separate form that introduces the raw output", () => {
        for (const code of codes) {
            const detail = readLocale(code).test?.unknown_error_detail;

            assert.ok(detail, `${code}.json has no test.unknown_error_detail`);
            assert.match(detail, /\{\{error}}/, `${code}'s detail form never shows the error`);
        }
    });

    it("is the detail form the panel uses, not the bare one plus punctuation", () => {
        const panel = readSource("client/src/common/components/TestDetails/TestDetails.jsx");

        assert.match(panel, /t\("test\.unknown_error_detail",\s*\{error:/,
            "the panel builds the sentence itself again, so the punctuation is back in the locale");
    });
});

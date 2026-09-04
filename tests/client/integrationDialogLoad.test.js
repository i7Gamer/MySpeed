import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";

const dialog = withoutJsComments(readSource("client/src/common/components/IntegrationDialog/IntegrationDialog.jsx"));

/**
 * The dialog set its two lists only on success and computed `loading` from
 * their absence, so a 500, a timeout or a non-array body left the ellipsis
 * animating for as long as the dialog stayed open, with the reason in the
 * console alone. Closing and reopening retried, which nobody is told. Every
 * sibling that can fail this way was given an error branch in an earlier
 * round; this one shows the reason and offers the retry it already had.
 */
describe("the integration dialog when its load fails", () => {
    it("keeps the failure rather than spinning on it", () => {
        assert.match(dialog, /setLoadError\(/, "a failed load is logged and nothing else");
        assert.match(dialog, /\.catch\(\(error\) => \{[\s\S]{0,200}setLoadError\(error\)/,
            "the catch does not record the error for the render");
    });

    it("says why, and offers to try again", () => {
        assert.match(dialog, /loadError\.message/, "the reason never reaches the dialog");
        assert.match(dialog, /t\("dialog\.retry"\)/, "there is no retry the reader can see");
    });

    it("clears the failure when it retries", () => {
        assert.match(dialog, /setLoadError\(null\)/, "a retry keeps the old error on screen");
    });
});

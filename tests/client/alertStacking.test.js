import { readSource } from "../helpers/source.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = readSource(path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "src", "common", "contexts", "Alert", "AlertContext.jsx"));

/**
 * Alerts stack - openAlert while another is open renders both - and every
 * renderer used to attach its own document-level keydown listener. One Enter
 * then submitted every open alert at once, the hidden one resolving with
 * whatever its input happened to hold, and Escape dismissed the whole stack.
 *
 * Only the topmost alert may listen; the ones beneath it wait their turn.
 */
describe("stacked alerts", () => {
    it("tell each renderer whether it is on top", () => {
        assert.match(source, /isTop=\{index === alerts\.length - 1\}/,
            "the provider never says which alert is topmost");
    });

    it("only the topmost alert listens for keys", () => {
        assert.match(source, /if \(!isTop\) return;[\s\S]{0,120}addEventListener\("keydown"/,
            "every stacked alert still answers Enter and Escape");
    });
});

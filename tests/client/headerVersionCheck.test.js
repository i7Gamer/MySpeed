import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, readSource } from "../helpers/source.js";

const HEADER = "client/src/common/components/Header/HeaderComponent.jsx";

/**
 * The header's "an update is available" banner, and which instance it describes.
 *
 * The effect that fetches /info/version was keyed on the whole `config` object.
 * reloadConfig gives that a new identity on every call, from a dozen places, so
 * every settings save, password change and node edit refetched a version none
 * of them had changed - the same waste NodeContext's own effect was narrowed to
 * avoid, with a comment saying so.
 *
 * Narrowing it to [configLoaded, config.viewMode] alone would have been a
 * regression rather than a fix: switching to a node running a different version
 * changes neither, so the effect would never re-run and the header would go on
 * advertising node A's update while pointed at node B. `updateAvailable` is
 * never reset anywhere, so nothing else would have corrected it.
 *
 * So it is keyed on the selection too, and clears the previous answer before
 * asking again.
 */
describe("the header's update check", () => {
    const source = readSource(HEADER);
    const effect = bodyIn(HEADER, "useEffect(");

    it("is not rerun by every unrelated config reload", () => {
        assert.doesNotMatch(source, /\}\s*,\s*\[config\]\s*\)/,
            "a settings save still refetches a version nothing changed");
    });

    it("is rerun when the viewed node changes", () => {
        const deps = source.match(/\}\s*,\s*\[([^\]]*)\]\s*\)/g) ?? [];

        assert.ok(deps.some((list) => /currentNode/.test(list)),
            "switching node leaves the header showing the previous node's version");
    });

    /**
     * Cleared before the fetch, not after it. The answer for the previous node
     * must not stay on screen while the new one is in flight, and a node that
     * is up to date answers with no banner at all - so nothing would clear it.
     */
    it("drops the previous answer before asking again", () => {
        assert.match(effect, /setUpdateAvailable\(\s*["'`]{2}\s*\)/,
            "the banner from the previously viewed node is never cleared");
    });
});

/**
 * Links that open a new tab.
 *
 * rel="noreferrer" on every one of them. Modern browsers imply noopener for
 * target="_blank", so this is about the Referer header rather than about
 * reverse tabnabbing - and the destinations are compile-time constants, so
 * there is no attacker-controlled page at the other end either. What makes it
 * worth doing is consistency: the dropdown already spells it this way for the
 * same URL, and a rule applied to two of five anchors is not a rule.
 */
describe("the header's outbound links", () => {
    /**
     * Every anchor in the file, not the one this was written for. tagHolding
     * would have been the obvious tool and the wrong one: it finds the first
     * occurrence of its marker, which for INSTALL_URL is the import at the top.
     */
    it("carries rel on every link the header opens in a new tab", () => {
        const anchors = readSource(HEADER).match(/<a\s[^>]*target=["']_blank["'][^>]*>/g) ?? [];

        assert.ok(anchors.length >= 1, "the header no longer opens any new tabs");
        for (const anchor of anchors)
            assert.match(anchor, /rel=["']noreferrer["']/, `${anchor} opens a tab without rel`);
    });

    // These two are the ones the update dialog actually renders, and they were
    // the ones a single-file fix would have missed.
    it("carries rel on both links in the update notice", () => {
        const infos = readSource("client/src/common/components/Header/utils/infos.jsx");
        const anchors = infos.match(/<a\s[^>]*target=["']_blank["'][^>]*>/g) ?? [];

        assert.ok(anchors.length >= 2, "the update notice no longer opens new tabs");
        for (const anchor of anchors)
            assert.match(anchor, /rel=["']noreferrer["']/, `${anchor} opens a tab without rel`);
    });
});

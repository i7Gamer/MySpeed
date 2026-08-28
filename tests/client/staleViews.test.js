import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

// These files explain the bugs below in their own comments, which would
// otherwise satisfy the very patterns that are supposed to be gone.
const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * Four views that kept showing something that was no longer true.
 *
 * Source-scanned: these are components with no render harness, so each regex
 * pins the mechanism that made the view stale rather than its layout.
 */

/**
 * A range switch during any in-flight fetch was dropped outright.
 *
 * loadInitialTests opened with `if (loadingRef.current) return;`, and that ref
 * is shared with loadMoreTests - so clicking a preset while a page was loading
 * discarded the new query with nothing to retry it. The response already in
 * flight then wrote the *old* query's rows into state and left the cursor
 * pointing into that result set, so the list went on mixing two queries.
 */
describe("the speedtest list supersedes rather than drops a query", () => {
    const context = code("common/contexts/Speedtests/SpeedtestContext.jsx");

    it("no longer abandons a load because another fetch is running", () => {
        assert.doesNotMatch(context, /if \(loadingRef\.current\) return;/,
            "a range or node switch is still discarded while a fetch is in flight");
    });

    it("marks earlier requests stale instead", () => {
        assert.match(context, /requestGeneration/,
            "nothing tells a superseded response not to write its rows");
    });

    // A page fetched for the previous range must not be merged into the new
    // list, and its cursor must not become the new cursor.
    it("discards a page that landed after the query changed", () => {
        const loadMore = context.slice(context.indexOf("const loadMoreTests"));

        assert.match(loadMore.slice(0, loadMore.indexOf("const refreshTests")),
            /generation !== requestGeneration\.current/,
            "a page load still settles against whatever query is current");
    });

    /**
     * The refresh needs the guard too, and more than the others do. Test ids
     * are per-instance, so a poll that was in flight when the node changed
     * comes back with another instance's rows: overlapping the new node's list
     * by id they are merged into it, overlapping none of it they replace it.
     */
    it("discards a refresh that landed after the query changed", () => {
        const refresh = context.slice(context.indexOf("const refreshTests"));

        assert.match(refresh.slice(0, refresh.indexOf("const deleteTest")),
            /generation !== requestGeneration\.current/,
            "a refresh still settles against whatever node or range is current");
    });

    /**
     * A node switch drops the rows before it asks for the new ones, not merely
     * when they arrive. Test and target ids are both per-instance, and
     * TargetsContext refills its byId map for the new node while the old rows
     * are still on screen - so for the length of the fetch, every visible row
     * was labelled and graded against another instance's targets that happen
     * to share its targetId numbers.
     */
    it("drops the previous node's rows before fetching the new one's", () => {
        assert.match(context, /lastNodeRef\.current !== currentNode/,
            "a node switch leaves the previous node's rows on screen until the answer lands");

        const effect = context.slice(context.indexOf("lastNodeRef.current !== currentNode"));
        assert.match(effect.slice(0, effect.indexOf("loadInitialTests();")), /setSpeedtests\(\[]\)/,
            "the switch is noticed but the rows are kept anyway");
    });
});

/**
 * A node that recovers but has not recorded a test yet returned before the
 * line that clears the error, and every healthy branch of the card is gated on
 * `!nodeError`. So once any poll had set one, the card stayed red on every
 * subsequent poll and switchNode refused to navigate - for PASSWORD_CHANGED it
 * re-prompted for a password that was already correct, indefinitely.
 */
describe("the node card clears a stale error", () => {
    const card = code("pages/Nodes/components/NodeContainer/NodeContainer.jsx");

    it("clears the error before reporting that tests are pending", () => {
        const pending = card.slice(card.indexOf("tests[0] === undefined"));

        assert.match(pending.slice(0, pending.indexOf("setNodeData")),
            /setNodeError\(undefined\)/,
            "a recovered node with no tests keeps whatever error the last poll set");
    });
});

/**
 * The statistics error branch was gated on `!deferredStatistics`, so after one
 * successful load it could never fire again. A later failure fell straight
 * through and rendered the *previous* range's numbers under the new range's
 * heading - and OverviewChart divides them by the new range's day count, so the
 * heading and the density disagreed with nothing to say why.
 */
describe("the statistics page does not show the previous range's numbers", () => {
    const statistics = code("pages/Statistics/Statistics.jsx");

    it("renders the error whenever a load failed", () => {
        assert.doesNotMatch(statistics, /loadError && !deferredStatistics/,
            "the error branch is still unreachable once anything has loaded");
        assert.match(statistics, /if \(loadError\)/);
    });

    it("still clears the error when a load succeeds", () => {
        assert.match(statistics, /setLoadError\(null\)/);
    });

    /**
     * The high-resolution series follows the node the way the page fetch
     * does. updateStats lists currentNode with a comment saying why; the
     * detail effect did not, and detailStatistics is never cleared on a node
     * change - so the previous node's thousand-point series would render
     * under the new node's heading. Unreachable today only by accident of
     * layout: switching nodes unmounts this page, and the expanded chart's
     * backdrop covers the header. The dependency is what guards it on
     * purpose.
     */
    it("re-keys the detail fetch on the node like the page fetch", () => {
        assert.match(statistics,
            /}, \[wantsDetail, isDownsampled, dateRange, targetFilter, currentNode]\);/,
            "a node switch would leave the previous node's series under the new node's heading");
    });
});

/**
 * The provider dialog resynced only three of its five fields when it opened.
 * serverId and the custom endpoint lived in an effect keyed on [provider,
 * config], and closing without saving changes neither - so an abandoned edit
 * survived, was shown on reopen as though it were stored, and was written on
 * the next unrelated save because it differed from what is stored. The dialog
 * is the target editor now; the disease and its cure moved with it.
 */
describe("the provider dialog resyncs every field it edits", () => {
    const dialog = code("common/components/TargetsDialog/TargetEditor.jsx");
    // The call, not the import above it.
    const onOpen = dialog.slice(dialog.indexOf("useSyncOnOpen(open"));
    const syncBody = onOpen.slice(0, onOpen.indexOf("});"));

    it("seeds the server id when it opens", () => {
        assert.match(syncBody, /setServerId\(/, "an abandoned server id survives the dialog closing");
    });

    it("seeds the custom URL when it opens", () => {
        assert.match(syncBody, /setEndpoint\(/, "an abandoned custom URL survives the dialog closing");
    });

    // Switching provider inside the dialog still has to re-read that provider's
    // stored server - but on the provider alone, not on the row prop or the
    // whole config.
    it("does not re-run its provider effect on every config change", () => {
        assert.doesNotMatch(dialog, /\}, \[provider, (config|target)\]\)/,
            "the field effect still keys on more than the provider, which is what made an edit look stored");
    });
});

/**
 * The one provider whose fetch had no generation guard left. Status, Node,
 * Targets and the speedtest list all mark a superseded request stale;
 * reloadConfig wrote whatever answered, in arrival order - so switching nodes
 * twice quickly, or a save's reload racing a node switch, could leave the
 * whole app reading another node's configuration until something reloaded it.
 */
describe("the config provider drops an answer for a config it has left", () => {
    const context = code("common/contexts/Config/ConfigContext.jsx");
    const reload = context.slice(context.indexOf("const reloadConfig"),
        context.indexOf("const checkConfig"));

    it("marks each request with a generation", () => {
        assert.match(reload, /const generation = \+\+requestGeneration\.current/,
            "nothing tells a superseded config response not to write itself");
    });

    it("drops a superseded answer instead of storing it", () => {
        assert.match(reload, /if \(superseded\(\)\) return/,
            "the slower, older response lands last and wins");
    });

    // The failure path steers navigation and dialogs; a stale failure must
    // not redirect the visitor away from a node that answered fine.
    it("drops a superseded failure too", () => {
        const failure = reload.slice(reload.indexOf(".catch("));

        assert.match(failure, /superseded\(\)/,
            "a stale failure still raises the error dialog over a working node");
    });
});

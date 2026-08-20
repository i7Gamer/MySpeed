import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The expanded chart is a modal in every visual sense and was none of it to a
 * screen reader.
 *
 * It painted a backdrop, locked the page scroll and answered Escape - and
 * carried no role, no name and no focus management: opening it left focus on
 * the card underneath the backdrop, Tab walked the whole inert page, closing
 * it dropped the reader at the top of the document, and the close control
 * announced as an empty button. Every Dialog in the app already does all four
 * through useModalFocus and the dialog contract; this holds the one overlay
 * rendered outside that context to the same terms.
 *
 * Read as source, the way keyboardReachableControls.test.js reads its
 * components: nothing here needs a DOM, only the promise that the markup says
 * what the styling implies.
 */
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const chartModal = read("client/src/common/components/ChartModal/ChartModal.jsx");
const statistics = read("client/src/pages/Statistics/Statistics.jsx");

/** The opening tag of the element carrying `marker`, attributes and all. */
const tagHolding = (source, marker) => {
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${marker} is no longer in this component`);

    return source.slice(source.lastIndexOf("<", at), source.indexOf(">", at) + 1);
};

describe("the chart modal is a dialog", () => {
    const content = tagHolding(chartModal, "chart-modal-content");

    it("says so", () => {
        assert.match(content, /role="dialog"/, "the overlay carries no role at all");
        assert.match(content, /aria-modal="true"/, "the page behind the backdrop is not announced as inert");
    });

    it("can hold focus itself, the way every Dialog can", () => {
        assert.match(content, /tabIndex=\{-1\}/,
            "focus has nowhere to sit when nothing inside is focusable");
    });

    it("is named", () => {
        assert.match(content, /aria-label=\{label\}/, "the dialog announces as nothing");
        assert.match(chartModal, /label[,}]/, "the component no longer takes a name");
    });
});

describe("the chart modal holds focus", () => {
    it("through the hook every other overlay uses", () => {
        assert.match(chartModal, /import\s*\{\s*useModalFocus\s*\}\s*from\s*"@\/common\/hooks\/useModalFocus"/,
            "the modal manages focus some other way, or not at all");
        assert.match(chartModal, /useModalFocus\(\w+,\s*\{open: isOpen\}\)/,
            "the trap is not keyed to the modal being open");
    });
});

describe("the chart modal's close control", () => {
    const close = tagHolding(chartModal, "chart-modal-close");

    it("declares its type rather than defaulting to submit", () => {
        assert.match(close, /type="button"/);
    });

    it("announces itself rather than an empty button", () => {
        assert.match(close, /aria-label=\{t\("dialog\.close"\)\}/,
            "the glyph renders aria-hidden, so the control has no name without one");
    });

    // The overlay contract: focus never opens on the dismiss control.
    it("is marked as the dismiss control", () => {
        assert.match(close, /data-overlay-dismiss/);
    });
});

/**
 * And the name is real: every chart the page can expand has a label, and every
 * label is a key both translations actually carry - an aria-label showing a
 * raw i18n key is a name in no language.
 */
describe("the expanded chart's name", () => {
    const chartTypes = [...statistics.matchAll(/case '(\w+)':/g)].map((match) => match[1]);

    const labelMap = () => {
        const literal = statistics.match(/CHART_MODAL_LABELS = \{([\s\S]*?)\}/)?.[1];
        assert.ok(literal, "the label map is gone from the statistics page");

        return Object.fromEntries([...literal.matchAll(/(\w+): "([\w.]+)"/g)]
            .map((match) => [match[1], match[2]]));
    };

    it("covers every chart the page can expand", () => {
        assert.ok(chartTypes.length > 0, "the chart switch is no longer readable");
        assert.deepEqual(Object.keys(labelMap()).sort(), [...chartTypes].sort(),
            "a chart can be expanded into a dialog with no name, or a name labels nothing");
    });

    it("names them in keys both translations carry", () => {
        for (const locale of ["en", "de"]) {
            const messages = JSON.parse(read(`client/public/assets/locales/${locale}.json`));
            const carried = (key) => key.split(".").reduce((node, part) => node?.[part], messages);

            for (const key of Object.values(labelMap()))
                assert.equal(typeof carried(key), "string", `${key} is not in ${locale}.json`);
        }
    });

    // Guarded, because the element is constructed while nothing is expanded
    // and t(undefined) is a name in no language either.
    it("hands the name to the modal", () => {
        assert.match(statistics, /label=\{expandedChart \? t\(CHART_MODAL_LABELS\[expandedChart\]\) : undefined\}/,
            "the map exists but the dialog is never named from it");
    });
});

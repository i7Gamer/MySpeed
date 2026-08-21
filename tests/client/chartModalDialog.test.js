import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, tagHolding } from "../helpers/source.js";

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
const chartModal = readSource("client/src/common/components/ChartModal/ChartModal.jsx");
const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");

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

    // The second assertion reads the props destructuring, not the file at
    // large: the old /label[,}]/ was satisfied by the aria-label attribute the
    // first assertion requires, so dropping the prop kept both green.
    it("is named", () => {
        assert.match(content, /aria-label=\{label\}/, "the dialog announces as nothing");
        assert.match(chartModal, /export const ChartModal = \(\{[^}]*\blabel\b[^}]*\}/,
            "the component no longer takes a name");
    });
});

/**
 * The overlays settle stacked Escapes with defaultPrevented - Dialog declines
 * a claimed key, DropdownSelect and the date picker prevent when they claim.
 * This modal checked only the Dialog-context overlays, so a picker left open
 * under it (reachable by keyboard) answered the same press: one Escape, two
 * overlays gone.
 */
describe("the chart modal's Escape", () => {
    it("declines a key something else has already answered", () => {
        assert.match(chartModal, /if \(e\.key !== "Escape" \|\| e\.defaultPrevented \|\| hasOpenOverlay\(\)\) return;/,
            "the modal is the one overlay outside the defaultPrevented treaty");
    });

    it("behaviorally declines when defaultPrevented is true", () => {
        const start = chartModal.indexOf("const handleEscape");
        assert.notEqual(start, -1, "the modal no longer defines handleEscape");
        const body = chartModal.slice(chartModal.indexOf("{", chartModal.indexOf("=>", start)));
        let depth = 0;
        let end = 0;
        for (let i = 0; i < body.length; i++) {
            if (body[i] === "{") depth++;
            else if (body[i] === "}" && --depth === 0) {
                end = i;
                break;
            }
        }
        let closed = false;
        const onClose = () => {
            closed = true;
        };
        const hasOpenOverlay = () => false;
        const handler = new Function("onClose", "hasOpenOverlay", `return (e) => ${body.slice(0, end + 1)};`)(onClose, hasOpenOverlay);

        const event = {
            key: "Escape",
            defaultPrevented: true,
            preventDefault() {
                this.defaultPrevented = true;
            }
        };
        handler(event);
        assert.equal(closed, false, "modal must not close when event is defaultPrevented");
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
            const messages = JSON.parse(readSource(`client/public/assets/locales/${locale}.json`));
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

    /**
     * And wherever a chart takes its title as a prop, the title IS the map
     * entry - one authority, not two copies. The charts that draw their own
     * internal titles (ping, hourly, consistency, latest, overview) cannot be
     * held this way without threading a prop through five components; for
     * them the map alone still carries the dialog's name.
     */
    it("names the prop-titled charts from the same map", () => {
        for (const key of ["download", "upload"])
            assert.equal((statistics.match(new RegExp(`titleKey=\\{CHART_MODAL_LABELS\\.${key}\\}`, "g")) ?? []).length, 2,
                `a ${key} chart names itself apart from the map the dialog reads`);

        for (const key of ["avgDownload", "avgUpload"])
            assert.equal((statistics.match(new RegExp(`title=\\{t\\(CHART_MODAL_LABELS\\.${key}\\)\\}`, "g")) ?? []).length, 2,
                `an average chart names itself apart from the map the dialog reads`);

        assert.doesNotMatch(statistics, /titleKey="latest\./,
            "a literal titleKey can drift from the dialog's name for the same chart");
    });
});

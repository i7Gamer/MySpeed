import {useLayoutEffect, useRef} from "react";
import i18n from "i18next";
import DateRangePicker from "@/common/components/DateRangePicker";
import StatusBarComponent from "@/common/components/StatusBar";
import StartTestButton from "@/common/components/StartTestButton";
import ExportButton from "@/common/components/ExportButton";
import {isAllTime} from "@/common/utils/TimeframeUtil";
import {controlsWrapped, TOOLBAR_CONTROLS, TOOLBAR_STAGES} from "./fit";
import "./styles.sass";

/** The top edge of each control that is on screen, rounded off the sub-pixel. */
const controlTops = (row) => TOOLBAR_CONTROLS.map((selector) => {
    const node = row.querySelector(selector);
    return node ? Math.round(node.getBoundingClientRect().top) : null;
});

/**
 * The controls that sit above a page of test data: the range they cover, the
 * status of the last run, a way to start another, and a way to take the data
 * away.
 *
 * Purely presentational - each page hands it the range it already owns, and
 * those two are deliberately different. The overview keeps its selection in the
 * speedtest context and defaults to every test it has; the statistics keep
 * theirs in the URL so a view stays bookmarkable and shareable. Unifying them
 * here would have to break one of those.
 */
export const PageToolbar = ({from, to, timeframe, onRangeChange, onTimeframeChange, exportRange}) => {
    const rowRef = useRef(null);

    /**
     * How much of itself the row can afford to draw - see fit.js for why this
     * is measured rather than written as a media query.
     *
     * Each stage is applied and then measured, keeping the first that holds one
     * line, so a label is given up only where it costs the toolbar a row. The
     * write and the read are one pass with no paint between them, which is what
     * useLayoutEffect buys: the alternative is drawing the wrapped row once and
     * collapsing it in the frame after, which reads as a flicker on every
     * resize.
     */
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row) return;

        let lastWidth = null;

        const apply = () => {
            lastWidth = row.clientWidth;

            for (const stage of TOOLBAR_STAGES) {
                row.dataset.compact = stage;
                if (!controlsWrapped(controlTops(row))) return;
            }
        };

        apply();

        // Only a change of width can change what fits. Guarded on it because
        // the stage this callback picks changes the row's *height* - a wrapped
        // toolbar is a line taller - and an unguarded observer would see its
        // own effect and call straight back into itself.
        const observer = new ResizeObserver(() => {
            if (row.clientWidth !== lastWidth) apply();
        });
        observer.observe(row);

        // A language changes the labels without changing the row, so no resize
        // is observed and the toolbar would keep the previous language's stage.
        // The selected range does the same and is a prop, so it is a dependency
        // below: "All time" is 126px and a pair of dates is 300.
        i18n.on("languageChanged", apply);

        return () => {
            observer.disconnect();
            i18n.off("languageChanged", apply);
        };
    }, [from, to, timeframe]);

    return (
        <div className="page-toolbar" data-compact="none" ref={rowRef}>
            <DateRangePicker
                from={from}
                to={to}
                timeframe={timeframe}
                onChange={onRangeChange}
                onTimeframeChange={onTimeframeChange}
            />

            <StatusBarComponent/>

            {/* Next to the status it acts on, and ahead of the export: the two of
                them are what the status bar used to hold, and starting a test is
                the action these pages are for. */}
            <StartTestButton/>

            {/* All time reaches the endpoint as a stand-in window; the export is
                named for what was asked for rather than for that window. */}
            <ExportButton dateRange={exportRange} allTime={isAllTime(timeframe)}/>
        </div>
    );
};

export default PageToolbar;

import {useContext, useRef} from "react";
import DateRangePicker from "@/common/components/DateRangePicker";
import StatusBarComponent from "@/common/components/StatusBar";
import StartTestButton from "@/common/components/StartTestButton";
import ExportButton from "@/common/components/ExportButton";
import TargetChips from "@/common/components/TargetChips";
import {TargetsContext} from "@/common/contexts/Targets";
import {isAllTime} from "@/common/utils/TimeframeUtil";
import {useFitStages} from "@/common/hooks/useFitStages";
import {TOOLBAR_CONTROLS, TOOLBAR_STAGES} from "./fit";
import "./styles.sass";

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
 *
 * `aside` is anything the page wants beside the chips rather than under them.
 * The chip row is short - a handful of operator-named targets - so a page that
 * has one more thing to say can say it in the room already there, and a whole
 * line is saved wherever the two fit. It is a slot rather than a prop of its
 * own because what goes there belongs to the page: the statistics put their
 * comparison row in it, and the overview has nothing to put.
 */
export const PageToolbar = ({from, to, timeframe, onRangeChange, onTimeframeChange, exportRange,
                                aside = null}) => {
    const rowRef = useRef(null);
    const {confirmedTarget} = useContext(TargetsContext);

    /*
     * The chip selection, read here rather than passed in - unlike the range,
     * which each page owns differently.
     *
     * The export is the third control in this row and has to mean what the two
     * beside it mean. It already honours the range; without this a page
     * narrowed to one target exported every target's rows into a file whose
     * name mentions only the dates, which is the kind of wrong answer nobody
     * checks because nothing on screen suggests it could be.
     *
     * The confirmed selection, not the one the pages query with. That one
     * trusts the stored chip before the target list has arrived, which a page
     * can afford because it re-asks; a download cannot be taken back, and a
     * guess that turned out to name a target this instance no longer has would
     * write an empty file with the right name on it. See queryTargetId.
     */
    const exportTarget = confirmedTarget;

    // How much of itself the row can afford to draw - fit.js for why this is
    // measured rather than written as a media query, useFitStages for the
    // triggers that keep the measurement honest.
    useFitStages(rowRef, TOOLBAR_STAGES, TOOLBAR_CONTROLS);

    return (
        <>
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
                <ExportButton dateRange={exportRange} allTime={isAllTime(timeframe)}
                              target={exportTarget}/>
            </div>

            {/* Its own row, outside the measured one: the fit stages above are
                sized to the four fixed controls, and a row of operator-named
                chips would make every measurement a function of the data. It
                renders nothing until the instance has two targets.

                Wrapped only when there is something to put beside it, so a page
                that passes no aside renders exactly the DOM it did before -
                including the `.statistic-area > .target-chips` margin rule,
                which reads it as a direct child. The wrapper is still outside
                rowRef, so an aside carrying a second date picker stays invisible
                to the fit ladder's first-match query. */}
            {aside === null ? <TargetChips/> : (
                <div className="toolbar-second-row">
                    <TargetChips/>
                    {aside}
                </div>
            )}
        </>
    );
};

export default PageToolbar;

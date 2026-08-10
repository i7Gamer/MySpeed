import DateRangePicker from "@/common/components/DateRangePicker";
import StatusBarComponent from "@/common/components/StatusBar";
import StartTestButton from "@/common/components/StartTestButton";
import ExportButton from "@/common/components/ExportButton";
import {isAllTime} from "@/common/utils/TimeframeUtil";
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
 */
export const PageToolbar = ({from, to, timeframe, onRangeChange, onTimeframeChange, exportRange}) => (
    <div className="page-toolbar">
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

export default PageToolbar;

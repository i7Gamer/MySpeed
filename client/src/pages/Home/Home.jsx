import {useContext} from "react";
import StatusBarComponent from "./components/StatusBar";
import StartTestButton from "./components/StartTestButton";
import TestAreaComponent from "./components/TestArea";
import DateRangePicker from "@/common/components/DateRangePicker";
import ExportButton from "@/common/components/ExportButton";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {OVERVIEW_TIMEFRAMES, resolveAllTime} from "@/common/utils/TimeframeUtil";
import "./styles.sass";

const Home = () => {
    const {timeframe, range, selectTimeframe, selectRange} = useContext(SpeedtestContext);

    return (
        <div>
            {/* One toolbar for the list below: range, status, export, start.
                The status bar is in the row rather than above it because a
                second full-width bar to hold the controls pushed the tests
                themselves off the first screen - and the start button is out
                of that bar because it was the only reason the bar had to be as
                tall as a card. */}
            <div className="overview-header">
                <DateRangePicker
                    from={range?.from ?? null}
                    to={range?.to ?? null}
                    timeframe={timeframe}
                    onChange={selectRange}
                    onTimeframeChange={selectTimeframe}
                    presets={OVERVIEW_TIMEFRAMES}
                />

                <StatusBarComponent/>

                {/* Next to the status it acts on, and ahead of the export: the
                    two of them are what the bar used to hold, and starting a
                    test is the action this page is for. */}
                <StartTestButton/>

                {/* All-time carries no range, but the export endpoint takes
                    one - resolveAllTime is that window. */}
                <ExportButton dateRange={range ?? resolveAllTime()}/>
            </div>

            <TestAreaComponent/>
        </div>
    );
};

export default Home;

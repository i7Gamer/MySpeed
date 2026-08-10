import {useContext} from "react";
import StatusBarComponent from "./components/StatusBar";
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
            {/* The range picker and the export sit on the status bar's own row
                rather than in a strip above it: all three are controls for the
                list below, and a second full-width bar to hold two of them
                pushed the tests themselves off the first screen. */}
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

                {/* All-time carries no range, but the export endpoint takes
                    one - resolveAllTime is that window. */}
                <ExportButton dateRange={range ?? resolveAllTime()}/>
            </div>

            <TestAreaComponent/>
        </div>
    );
};

export default Home;

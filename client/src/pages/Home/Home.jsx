import {useContext} from "react";
import PageToolbar from "@/common/components/PageToolbar";
import TestAreaComponent from "./components/TestArea";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {resolveAllTime} from "@/common/utils/TimeframeUtil";

const Home = () => {
    const {timeframe, range, selectTimeframe, selectRange} = useContext(SpeedtestContext);

    return (
        <div>
            <PageToolbar
                from={range?.from ?? null}
                to={range?.to ?? null}
                timeframe={timeframe}
                onRangeChange={selectRange}
                onTimeframeChange={selectTimeframe}
                // All-time carries no range, but the export endpoint takes one
                // - resolveAllTime is that window.
                exportRange={range ?? resolveAllTime()}
            />

            <TestAreaComponent/>
        </div>
    );
};

export default Home;

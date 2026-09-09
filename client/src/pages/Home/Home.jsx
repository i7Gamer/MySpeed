import {useContext} from "react";
import {useTranslation} from "react-i18next";
import PageToolbar from "@/common/components/PageToolbar";
import TestAreaComponent from "./components/TestArea";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {resolveAllTime} from "@/common/utils/TimeframeUtil";

const Home = () => {
    // Router elements are created once; the providers' language render cannot
    // refresh their unchanged children. Subscribe here without remounting rows.
    useTranslation();
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

import React, {useState, createContext, useEffect} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {pollIntervalFor, sameStatus} from "@/common/utils/StatusUtil";

export const StatusContext = createContext({});

export const StatusProvider = (props) => {

    const [status, setStatus] = useState({paused: false, running: false});

    // Polled every few seconds, so a transient failure must not reject: keep the
    // last known status rather than tearing down the interval.
    //
    // The previous object is kept when the answer has not changed, the way
    // mergeNewTests keeps its list. Storing every parsed response re-rendered
    // this provider on every poll - and SpeedtestProvider with it, since that
    // one consumes this context and rebuilds its own value - so TestArea and
    // every row were redrawn every five seconds at idle and every second during
    // a run, to show exactly what was already on screen.
    const updateStatus = () => jsonRequest("/speedtests/status")
        .then(next => setStatus(prev => sameStatus(prev, next) ? prev : next))
        .catch(() => undefined);

    const setRunning = (running) => setStatus(prev => ({...prev, running}));

    // The interval follows the state rather than being fixed: a progress bar
    // driven at the idle rate would step through a whole run in fifths, and
    // polling that fast forever is wasted on a page left open overnight. The
    // effect re-runs when the rate changes, which is what swaps the timer.
    const interval = pollIntervalFor(status);

    useEffect(() => {
        updateStatus();
        // A hidden tab skips the tick rather than tearing the timer down: a
        // wall dashboard in a background tab has nobody looking at it, and the
        // visibility listener catches it up the moment somebody does.
        const timer = setInterval(() => {
            if (!document.hidden) updateStatus();
        }, interval);
        const onVisibilityChange = () => {
            if (!document.hidden) updateStatus();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [interval]);

    return (
        <StatusContext.Provider value={[status, updateStatus, setRunning]}>
            {props.children}
        </StatusContext.Provider>
    )
}
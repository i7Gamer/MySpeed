import React, {useState, createContext, useEffect} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {pollIntervalFor} from "@/common/utils/StatusUtil";

export const StatusContext = createContext({});

export const StatusProvider = (props) => {

    const [status, setStatus] = useState({paused: false, running: false});

    // Polled every few seconds, so a transient failure must not reject: keep the
    // last known status rather than tearing down the interval.
    const updateStatus = () => jsonRequest("/speedtests/status")
        .then(status => setStatus(status))
        .catch(() => undefined);

    const setRunning = (running) => setStatus(prev => ({...prev, running}));

    // The interval follows the state rather than being fixed: a progress bar
    // driven at the idle rate would step through a whole run in fifths, and
    // polling that fast forever is wasted on a page left open overnight. The
    // effect re-runs when the rate changes, which is what swaps the timer.
    const interval = pollIntervalFor(status);

    useEffect(() => {
        updateStatus();
        const timer = setInterval(() => updateStatus(), interval);
        return () => clearInterval(timer);
    }, [interval]);

    return (
        <StatusContext.Provider value={[status, updateStatus, setRunning]}>
            {props.children}
        </StatusContext.Provider>
    )
}
import React, {useState, createContext, useEffect} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";

export const StatusContext = createContext({});

export const StatusProvider = (props) => {

    const [status, setStatus] = useState({paused: false, running: false});

    // Polled every few seconds, so a transient failure must not reject: keep the
    // last known status rather than tearing down the interval.
    const updateStatus = () => jsonRequest("/speedtests/status")
        .then(status => setStatus(status))
        .catch(() => undefined);

    const setRunning = (running) => setStatus(prev => ({...prev, running}));

    useEffect(() => {
        updateStatus();
        const interval = setInterval(() => updateStatus(), 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <StatusContext.Provider value={[status, updateStatus, setRunning]}>
            {props.children}
        </StatusContext.Provider>
    )
}
import React, {useState, createContext, useEffect} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {LIVE_POLL_MS, pollIntervalFor, runJustFinished, sameStatus, withLive} from "@/common/utils/StatusUtil";

export const StatusContext = createContext({});

const NOT_FOUND = 404;

export const StatusProvider = (props) => {

    const [status, setStatus] = useState({paused: false, running: false});

    // Whether this server answers /status/live, assumed until a 404 says
    // otherwise. A remote node on an older version - reached through the node
    // proxy this client may be pointed at - never will, and the answer sends
    // the client back to the fast full poll for the length of the session.
    const [liveSupported, setLiveSupported] = useState(true);

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

    // The interval follows the state rather than being fixed: polling fast
    // forever is wasted on a page left open overnight, and the full route is
    // the expensive one - two database queries and three config reads a call.
    // While the live poll below watches a run, this one stays at its idle pace;
    // it hurries only against a server that has no live route to watch. The
    // effect re-runs when the rate changes, which is what swaps the timer.
    const interval = pollIntervalFor(status, liveSupported);

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

    /**
     * The run itself, sampled from the route that answers without touching the
     * database. Everything else about this provider is per-poll bookkeeping;
     * this is what makes the progress bar move like a measurement instead of a
     * clock.
     *
     * The falling edge is caught here first - the sample that says the run
     * ended arrives seconds before the slow poll would notice - and triggers
     * the one full refresh the end of a run deserves: the new row, the failure
     * count, the next scheduled time. SpeedtestContext refetches the list off
     * the same edge, since it watches status.running.
     *
     * A 404 is the one error that means anything: the route is not there, and
     * will not be for the rest of the session. Anything else - a timeout, a
     * 500 - keeps the last sample, exactly as the full poll does.
     */
    useEffect(() => {
        if (!status.running || !liveSupported) return;

        const updateLive = () => jsonRequest("/speedtests/status/live")
            .then(live => {
                if (runJustFinished(status.running, live.running)) updateStatus();
                setStatus(prev => withLive(prev, live));
            })
            .catch(error => {
                if (error?.status === NOT_FOUND) setLiveSupported(false);
            });

        updateLive();
        // A hidden tab skips the tick, like the full poll above: the sample
        // would move a bar nobody is looking at.
        const timer = setInterval(() => {
            if (!document.hidden) updateLive();
        }, LIVE_POLL_MS);
        return () => clearInterval(timer);
    }, [status.running, liveSupported]);

    return (
        <StatusContext.Provider value={[status, updateStatus, setRunning]}>
            {props.children}
        </StatusContext.Provider>
    )
}
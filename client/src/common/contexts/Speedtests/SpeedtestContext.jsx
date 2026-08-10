import React, {useState, createContext, useContext, useEffect, useCallback, useRef} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {runJustFinished} from "@/common/utils/StatusUtil";
import {StatusContext} from "@/common/contexts/Status";
import {NodeContext} from "@/common/contexts/Node";
import {
    TIMEFRAME_ALL, formatDateParam, isAllTime, resolveTimeframe, timeframeFromRange
} from "@/common/utils/TimeframeUtil";
import {mergeNewTests} from "./merge";

export const SpeedtestContext = createContext({});

// One page of the list, and the yardstick for whether another one exists: a
// short page is the last one. Written down once because the fetch and that
// judgement have to agree.
const PAGE_SIZE = 30;

export const SpeedtestProvider = (props) => {
    const [speedtests, setSpeedtests] = useState([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [lastId, setLastId] = useState(null);
    const loadingRef = useRef(false);
    const lastLoadTimeRef = useRef(0);
    const [status] = useContext(StatusContext);
    const [, , currentNode] = useContext(NodeContext);
    const wasRunningRef = useRef(status.running);

    // The overview's date picker. All-time is the default and carries no range
    // at all - "everything" is the absence of a bound rather than a very wide
    // one - so the list behaves exactly as it did until a range is chosen.
    const [timeframe, setTimeframe] = useState(TIMEFRAME_ALL);
    const [range, setRange] = useState(null);

    const listQuery = useCallback((extra = {}) => {
        const params = new URLSearchParams({limit: String(PAGE_SIZE), ...extra});

        if (range) {
            params.set("from", formatDateParam(range.from));
            params.set("to", formatDateParam(range.to));
            // The server would otherwise cut days on its own clock, which is
            // UTC in the Docker image and rarely matches the viewer's.
            params.set("tzOffset", String(new Date().getTimezoneOffset()));
        }

        return params.toString();
    }, [range]);

    const selectTimeframe = useCallback((id) => {
        setTimeframe(id);
        setRange(isAllTime(id) ? null : resolveTimeframe(id));
    }, []);

    const selectRange = useCallback((from, to) => {
        setTimeframe(timeframeFromRange(from, to));
        setRange({from, to});
    }, []);

    const loadInitialTests = useCallback(async () => {
        if (loadingRef.current) return;

        loadingRef.current = true;
        setLoading(true);
        try {
            const tests = await jsonRequest(`/speedtests?${listQuery()}`);
            setSpeedtests(tests);
            if (tests.length > 0) {
                setLastId(tests[tests.length - 1].id);
                setHasMore(tests.length === PAGE_SIZE);
            } else {
                setLastId(null);
                setHasMore(false);
            }
        } catch (error) {
            console.error("Failed to load initial tests:", error);
            setSpeedtests([]);
            setLastId(null);
            setHasMore(false);
        } finally {
            setLoading(false);
            loadingRef.current = false;
        }
    }, [listQuery]);

    const loadMoreTests = useCallback(async () => {
        const now = Date.now();
        if (loadingRef.current || !hasMore || !lastId || (now - lastLoadTimeRef.current) < 500) return;

        lastLoadTimeRef.current = now;
        loadingRef.current = true;
        setLoading(true);
        try {
            const newTests = await jsonRequest(`/speedtests?${listQuery({afterId: lastId})}`);
            if (newTests.length > 0) {
                setSpeedtests(prev => {
                    const existingIds = new Set(prev.map(test => test.id));
                    const uniqueNewTests = newTests.filter(test => !existingIds.has(test.id));

                    if (uniqueNewTests.length > 0) {
                        setLastId(newTests[newTests.length - 1].id);
                        return [...prev, ...uniqueNewTests];
                    }
                    return prev;
                });
                setHasMore(newTests.length === PAGE_SIZE);
            } else {
                setHasMore(false);
            }
        } catch (error) {
            console.error("Failed to load more tests:", error);
            setHasMore(false);
            setTimeout(() => {
                if (lastId) setHasMore(true);
            }, 3000);
        } finally {
            setLoading(false);
            loadingRef.current = false;
        }
    }, [hasMore, lastId, listQuery]);

    const refreshTests = useCallback(async () => {
        const hasTests = speedtests.length > 0;

        try {
            const newTests = await jsonRequest(`/speedtests?${listQuery()}`);
            if (newTests.length === 0) return;

            if (hasTests) {
                // mergeNewTests decides what is actually new. Doing it by id here
                // grew the list without bound on any instance restored from a
                // backup - see the note in merge.js.
                setSpeedtests(prev => mergeNewTests(prev, newTests));
            } else {
                setSpeedtests(newTests);
                setLastId(newTests[newTests.length - 1].id);
                setHasMore(newTests.length === PAGE_SIZE);
            }
        } catch (error) {
            console.error("Failed to refresh tests:", error);
        }
    }, [speedtests, listQuery]);

    // Derives the new cursor from `prev` inside the updater rather than from the
    // captured `speedtests`, so it stays correct regardless of render timing and
    // cannot index into an empty list.
    const deleteTest = useCallback((id) => {
        setSpeedtests(prev => {
            const remaining = prev.filter(test => test.id !== id);

            if (remaining.length === 0) {
                setLastId(null);
                setHasMore(false);
            } else if (remaining.length < prev.length) {
                setLastId(remaining[remaining.length - 1].id);
            }

            return remaining;
        });
    }, []);

    const updateTests = useCallback(() => {
        refreshTests();
    }, [refreshTests]);

    // Keyed on the node, and on the selected range through loadInitialTests:
    // both change what the endpoint answers with, and the list has to be
    // replaced rather than merged - the previous node's tests used to linger
    // under the new node's until the next full reload, and a narrowed range
    // would otherwise leave the tests outside it on screen.
    useEffect(() => {
        loadInitialTests();
    }, [currentNode, loadInitialTests]);

    // The list used to be refetched every five seconds around the clock. A new
    // row can only appear when a run ends, and the polled status already says
    // when that is - so the refresh rides its falling edge instead. Manual runs
    // stay covered twice over: RunUtil refreshes explicitly when the run call
    // returns, and the flag falls either way.
    useEffect(() => {
        if (runJustFinished(wasRunningRef.current, status.running)) refreshTests();
        wasRunningRef.current = status.running;
    }, [status.running, refreshTests]);

    // A hidden tab gets no status polls, so a run can end entirely unseen;
    // coming back to the tab is the moment to catch up.
    useEffect(() => {
        const onVisibilityChange = () => {
            if (!document.hidden) refreshTests();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }, [refreshTests]);

    return (
        <SpeedtestContext.Provider value={{speedtests, updateTests, deleteTest, loadMoreTests, loading, hasMore,
            timeframe, range, selectTimeframe, selectRange}}>
            {props.children}
        </SpeedtestContext.Provider>
    )
}
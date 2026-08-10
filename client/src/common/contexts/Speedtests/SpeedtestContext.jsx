import React, {useState, createContext, useContext, useEffect, useCallback, useRef} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {runJustFinished} from "@/common/utils/StatusUtil";
import {StatusContext} from "@/common/contexts/Status";
import {NodeContext} from "@/common/contexts/Node";
import {mergeNewTests} from "./merge";

export const SpeedtestContext = createContext({});

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

    const loadInitialTests = useCallback(async () => {
        if (loadingRef.current) return;

        loadingRef.current = true;
        setLoading(true);
        try {
            const tests = await jsonRequest("/speedtests?limit=30");
            setSpeedtests(tests);
            if (tests.length > 0) {
                setLastId(tests[tests.length - 1].id);
                setHasMore(tests.length === 30);
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
    }, []);

    const loadMoreTests = useCallback(async () => {
        const now = Date.now();
        if (loadingRef.current || !hasMore || !lastId || (now - lastLoadTimeRef.current) < 500) return;

        lastLoadTimeRef.current = now;
        loadingRef.current = true;
        setLoading(true);
        try {
            const newTests = await jsonRequest(`/speedtests?limit=30&afterId=${lastId}`);
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
                setHasMore(newTests.length === 30);
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
    }, [hasMore, lastId]);

    const refreshTests = useCallback(async () => {
        const hasTests = speedtests.length > 0;

        try {
            const newTests = await jsonRequest("/speedtests?limit=30");
            if (newTests.length === 0) return;

            if (hasTests) {
                // mergeNewTests decides what is actually new. Doing it by id here
                // grew the list without bound on any instance restored from a
                // backup - see the note in merge.js.
                setSpeedtests(prev => mergeNewTests(prev, newTests));
            } else {
                setSpeedtests(newTests);
                setLastId(newTests[newTests.length - 1].id);
                setHasMore(newTests.length === 30);
            }
        } catch (error) {
            console.error("Failed to refresh tests:", error);
        }
    }, [speedtests]);

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

    // Keyed on the node: switching one swaps what every request answers with,
    // and the list has to be replaced, not merged - the previous node's tests
    // used to linger under the new node's until the next full reload.
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
        <SpeedtestContext.Provider value={{speedtests, updateTests, deleteTest, loadMoreTests, loading, hasMore}}>
            {props.children}
        </SpeedtestContext.Provider>
    )
}
import React, {useState, createContext, useContext, useEffect, useCallback, useMemo, useRef} from "react";
import {useSearchParams} from "react-router-dom";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {runJustFinished} from "@/common/utils/StatusUtil";
import {StatusContext} from "@/common/contexts/Status";
import {NodeContext} from "@/common/contexts/Node";
import {
    formatDateParam, rangeToParams, selectionFromParams, timeframeFromRange
} from "@/common/utils/TimeframeUtil";
import {mergeNewTests} from "./merge";
import {applyPage, cursorOf, removeTest} from "./paging";

export const SpeedtestContext = createContext({});

// One page of the list, and the yardstick for whether another one exists: a
// short page is the last one. Written down once because the fetch and that
// judgement have to agree.
const PAGE_SIZE = 30;

export const SpeedtestProvider = (props) => {
    const [speedtests, setSpeedtests] = useState([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    // Where the next page starts: the last row's `created` and its id, because
    // that pair is what the list is ordered by. The id alone was the cursor
    // once, and on any instance restored from a backup - where id 1 is the
    // newest test - it asked for pages the list had already shown.
    const [cursor, setCursor] = useState(null);
    const loadingRef = useRef(false);
    const lastLoadTimeRef = useRef(0);
    const [status] = useContext(StatusContext);
    const [, , currentNode] = useContext(NodeContext);
    const wasRunningRef = useRef(status.running);

    /**
     * The overview's date picker, kept in the URL rather than in state here.
     *
     * The statistics page keeps its range in the URL so a view stays
     * bookmarkable and shareable; held in state, the overview's reset on every
     * reload and could not be linked to at all. One source of truth also means
     * the two cannot disagree about what the address bar says.
     *
     * All time is the default and carries no range at all - "everything" is the
     * absence of a bound rather than a very wide one - so the list behaves
     * exactly as it did until a range is chosen.
     */
    const [searchParams, setSearchParams] = useSearchParams();
    const search = searchParams.toString();

    const selection = useMemo(() => selectionFromParams(new URLSearchParams(search)), [search]);
    const timeframe = selection.timeframe;
    const range = useMemo(
        () => selection.from && selection.to ? {from: selection.from, to: selection.to} : null,
        [selection]);

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

    // Replaced rather than pushed: narrowing a range is refining one view, not
    // arriving at a new one, and stacking every adjustment would make Back walk
    // through each of them.
    const selectTimeframe = useCallback((id) => {
        setSearchParams(rangeToParams(id), {replace: true});
    }, [setSearchParams]);

    const selectRange = useCallback((from, to) => {
        setSearchParams(rangeToParams(timeframeFromRange(from, to), from, to), {replace: true});
    }, [setSearchParams]);

    const loadInitialTests = useCallback(async () => {
        if (loadingRef.current) return;

        loadingRef.current = true;
        setLoading(true);
        try {
            const tests = await jsonRequest(`/speedtests?${listQuery()}`);
            setSpeedtests(tests);
            if (tests.length > 0) {
                setCursor(cursorOf(tests));
                setHasMore(tests.length === PAGE_SIZE);
            } else {
                setCursor(null);
                setHasMore(false);
            }
        } catch (error) {
            console.error("Failed to load initial tests:", error);
            setSpeedtests([]);
            setCursor(null);
            setHasMore(false);
        } finally {
            setLoading(false);
            loadingRef.current = false;
        }
    }, [listQuery]);

    // The paging judgements live in paging.js. They used to run inside the
    // setSpeedtests updater - which React runs twice under StrictMode, firing
    // the setCursor it carried twice - and the cursor only advanced when a
    // page brought something new, so a page of already-known rows (the overlap
    // a refresh can leave) was refetched forever.
    //
    // The list itself still changes through an updater: a refresh can prepend
    // rows while this fetch is in flight, and replacing the state with a fold
    // over a snapshot would throw those away. The cursor and hasMore need no
    // snapshot at all - both are read off the fetched page alone.
    const loadMoreTests = useCallback(async () => {
        const now = Date.now();
        if (loadingRef.current || !hasMore || !cursor || (now - lastLoadTimeRef.current) < 500) return;

        lastLoadTimeRef.current = now;
        loadingRef.current = true;
        setLoading(true);
        try {
            const fetched = await jsonRequest(
                `/speedtests?${listQuery({after: cursor.created, afterId: cursor.id})}`);
            if (fetched.length > 0) {
                setSpeedtests(prev => applyPage(prev, fetched, PAGE_SIZE).tests);
                setCursor(cursorOf(fetched));
                setHasMore(fetched.length === PAGE_SIZE);
            } else {
                setHasMore(false);
            }
        } catch (error) {
            console.error("Failed to load more tests:", error);
            setHasMore(false);
            setTimeout(() => {
                if (cursor) setHasMore(true);
            }, 3000);
        } finally {
            setLoading(false);
            loadingRef.current = false;
        }
    }, [hasMore, cursor, listQuery]);

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
                setCursor(cursorOf(newTests));
                setHasMore(newTests.length === PAGE_SIZE);
            }
        } catch (error) {
            console.error("Failed to refresh tests:", error);
        }
    }, [speedtests, listQuery]);

    // The list changes through an updater so a concurrent refresh cannot be
    // clobbered; the cursor comes from a fold over the snapshot, which is safe
    // here because a refresh only prepends - the last row, which is all the
    // cursor reads, is the same either way. The old version derived the cursor
    // inside the updater, whose side effects fired twice under StrictMode.
    const deleteTest = useCallback((id) => {
        const removal = removeTest(speedtests, id);

        setSpeedtests(prev => removeTest(prev, id).tests);
        setCursor(removal.cursor);
        if (removal.exhausted) setHasMore(false);
    }, [speedtests]);

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
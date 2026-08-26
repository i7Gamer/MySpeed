import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {pageTarget, selectedTargetId} from "@/common/utils/TargetUtil";
import {reloadOnPermissionChange} from "@/common/contexts/Speedtests/permission";
import {readStored} from "@/common/utils/Storage";
import {welcomeOpens} from "./welcomeOutcome";
import WelcomeDialog from "@/common/components/WelcomeDialog";

export const TargetsContext = createContext({});

/**
 * The instance's targets, in round order, for everything that labels by them:
 * the manager dialog, the chip row, the row dots, the Target fact and the
 * per-target grading. One fetch shared by all of them - the list is a handful
 * of rows and changes only when the operator edits it.
 *
 * A viewer gets the redacted shape (no endpoints, no server ids, no alerts
 * flag); everything outside the manager dialog reads only the fields both
 * shapes carry.
 *
 * The welcome wizard hangs here rather than on the config, because "this
 * instance is not set up yet" stopped being a config key: it is now an empty
 * target list. ConfigProvider used to open it on provider === "none".
 */
export const TargetsProvider = ({children}) => {
    const [config] = useContext(ConfigContext);
    const [, , currentNode] = useContext(NodeContext);
    const [preferences] = useContext(PreferencesContext);
    // null while the first fetch is in flight, and again whenever the instance
    // being looked at changes.
    const [targets, setTargets] = useState(null);
    const [welcomeShown, setWelcomeShown] = useState(false);
    /**
     * Bumped by every fresh query, so an answer for a node the viewer has left
     * can tell that it is no longer wanted. SpeedtestContext's discipline, and
     * here for a sharper reason than staleness: target ids are per-instance, so
     * another node's list does not merely lag - it puts that node's names and
     * colours on this node's rows, and resolves the chip preference against a
     * target that means something else.
     */
    const requestGeneration = useRef(0);
    // The permission the list in hand was fetched under - see permission.js.
    const fetchedUnderRef = useRef(undefined);
    /**
     * Whether this instance has had a target at any point while it has been on
     * screen. What makes the wizard a first-run experience rather than a modal
     * that returns: an operator who deletes their only target to replace it is
     * mid-workflow in the manager, not setting the instance up.
     *
     * A ref, because it is read by the fetch that sets it and must not be a
     * render behind - and reset per node, since it describes one instance.
     */
    const everHadTargets = useRef(false);

    const reloadTargets = useCallback(async () => {
        const generation = ++requestGeneration.current;
        const superseded = () => generation !== requestGeneration.current;

        try {
            const rows = await jsonRequest("/targets");
            if (superseded()) return;

            const list = Array.isArray(rows) ? rows : [];
            if (list.length > 0) everHadTargets.current = true;

            setTargets(list);
        } catch {
            /*
             * The list is left exactly as it was, which for a first load means
             * still null.
             *
             * This used to record a failure as an empty list, and an empty list
             * is the one thing that means "this instance has nothing to
             * measure": a 500, a 503 from in front of a restarting container,
             * or the 10s timeout therefore raised the setup wizard - which
             * cannot be dismissed - over a configured instance that was working
             * a moment earlier. jsonRequest throws for all of those the same
             * way, so the answer here cannot tell them apart; what it can do is
             * not invent a state the server never reported.
             */
        }
    }, []);

    // The config fetch is what signals a reachable, authenticated instance -
    // narrowed to its emptiness deliberately, because the object's identity
    // changes on every reload and each one would refetch this list.
    const configLoaded = Object.keys(config).length > 0;

    useEffect(() => {
        if (!configLoaded) return;

        // Dropped, not kept, while the answer is on its way: getApiRoot re-aims
        // every request when the node changes, and the previous instance's
        // names must not label the new instance's rows in the meantime.
        setTargets(null);
        everHadTargets.current = false;
        reloadTargets();
    }, [currentNode, configLoaded, reloadTargets]);

    /**
     * And again when the session's permission changes, which changes what the
     * endpoint puts in each row rather than which rows it answers with.
     *
     * A read-only visitor is served viewerFacing rows - no serverId, no
     * endpoint, no alerts flag - and signing in through the header gear is the
     * one login path that does not reload the page. Without this the redacted
     * rows stayed in hand for the rest of the session, and the editor seeds its
     * fields from the row it is handed: opening a target and saving it wrote
     * that redaction back, silently clearing the pinned server and the custom
     * backend URL and switching the target's alerting off. SpeedtestContext
     * carries the same guard for the same login, against the same disease.
     */
    useEffect(() => {
        fetchedUnderRef.current = reloadOnPermissionChange(
            fetchedUnderRef.current, config.viewMode, reloadTargets);
    }, [config.viewMode, reloadTargets]);

    /**
     * When the wizard opens itself - the decision is welcomeOutcome's, which
     * is where it can be read and tested without a browser.
     *
     * Only ever raised here, never lowered: the dialog closes through its own
     * onClose, and finishing it leaves a target behind, so the condition that
     * opened it is false by the time this runs again.
     */
    useEffect(() => {
        if (welcomeOpens({
            config,
            // A list that has arrived, is empty, and has never held anything on
            // this instance - see everHadTargets.
            firstRun: targets === null ? null : targets.length === 0 && !everHadTargets.current,
            alreadyShown: readStored("welcomeShown")
        })) setWelcomeShown(true);
        // The config is narrowed to the two fields the decision reads: its
        // object identity changes on every reload, and listing it whole would
        // re-run this on each one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [configLoaded, config.previewMode, config.viewMode, targets]);

    const value = useMemo(() => {
        const list = targets ?? [];

        return {
            loaded: targets !== null,
            targets: list,
            byId: Object.fromEntries(list.map((target) => [target.id, target])),
            /**
             * The chip selection, resolved once here rather than in each of the
             * five places that narrow by it - the rule has several ways to
             * answer null (too few targets, a deleted target, a choice made on
             * another node) and five copies of it would be five chances for the
             * list, the statistics, the export and the row dots to disagree
             * about what the page is showing.
             */
            selectedTarget: selectedTargetId(preferences, list, currentNode),
            // And the target a whole page is showing, which is not the same
            // question - see pageTarget.
            pageTarget: pageTarget(list, preferences, currentNode),
            // What the chip row writes, so the node it was chosen on travels
            // with it.
            selectionFor: (id) => ({selectedTarget: id, selectedTargetNode: currentNode ?? null}),
            reloadTargets
        };
    }, [targets, preferences, currentNode, reloadTargets]);

    return (
        <TargetsContext.Provider value={value}>
            <WelcomeDialog open={welcomeShown} onClose={() => setWelcomeShown(false)}/>
            {children}
        </TargetsContext.Provider>
    );
};

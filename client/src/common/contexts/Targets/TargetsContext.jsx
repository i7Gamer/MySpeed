import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {chipIsStale, NO_SELECTION, pageTarget, queryTargetId, selectedTargetId} from "@/common/utils/TargetUtil";
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
    const [preferences, updatePreferences] = useContext(PreferencesContext);
    // null while the first fetch is in flight, and again whenever the instance
    // being looked at changes.
    const [targets, setTargets] = useState(null);
    /**
     * Which instance the list above was fetched from.
     *
     * Switching nodes neither remounts this provider nor empties the list
     * during render - the reset is the effect below - so there is a commit that
     * holds the destination node beside the targets of the node just left. Read
     * wrong, that lasted one render and nothing acted on it; the effect that
     * clears a dead chip acts, and writes localStorage, so it has to be able to
     * tell whether the pair in its hands describes one instance or two. See
     * chipIsStale.
     *
     * Written beside every setTargets(null) rather than where an answer lands,
     * which is what makes the two impossible to tear apart: the pair is set
     * before the request that will fill it is issued, and the only thing that
     * fills it drops answers for a node the viewer has left. State rather than
     * a ref, because it is read from an effect's closure next to the list it
     * describes, and a ref would hand that closure a value from a later commit
     * than the list it is judging.
     */
    const [targetsNode, setTargetsNode] = useState(currentNode);
    /**
     * Whether the fetch that would have filled it has already failed.
     *
     * The one thing the list cannot say about itself: null means both "the
     * answer is coming" and "no answer is ever coming", because a failed fetch
     * deliberately leaves the list untouched and only a node or a permission
     * change asks again. That was a distinction without a difference until
     * queryTargetId began narrowing the first requests by the stored chip while
     * an answer is on its way - a guess is cheap for exactly as long as
     * something is due to correct it, and permanent the moment nothing is.
     * Cleared by each new attempt, so a retry is allowed to guess again.
     */
    const [targetsFailed, setTargetsFailed] = useState(false);
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

        // An answer is due again, so the optimistic filter is allowed again -
        // see targetsFailed. Already false on a first load, where React drops
        // the identical write rather than rendering for it.
        setTargetsFailed(false);

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
             *
             * Recording that the attempt is over is a different statement from
             * recording what it found, and that one is both true and needed:
             * nothing here will ask again, and queryTargetId may only guess
             * while something is still due to correct it. Skipped for an answer
             * that has been superseded, whose failure says nothing about the
             * request that replaced it.
             */
            if (!superseded()) setTargetsFailed(true);
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
        // And which instance the list now being fetched will have come from,
        // written here so it can never describe a different one from the list
        // beside it - see targetsNode. After the drop rather than before it, so
        // that a pair somehow read apart says "no list yet" rather than putting
        // this node's name over the node just left's targets. React drops the
        // write where the node has not moved, so a permission refetch does not
        // render for it.
        setTargetsNode(currentNode);
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

    /**
     * And a chip that has stopped meaning anything is thrown away rather than
     * left to be guessed from - see chipIsStale for why that stopped being
     * harmless once the first request began trusting it, and why it is told
     * which instance the list came from as well as which one is being looked
     * at.
     *
     * The decision is the utility's, so it can be read and tested without a
     * browser; all that is left here is the write. It clears one browser's
     * choice for one instance - the node stamp travels with the choice - and it
     * is its own last run, because the preference it reacts to is the one it
     * empties.
     */
    useEffect(() => {
        if (chipIsStale(preferences, targets, currentNode, targetsNode)) updatePreferences(NO_SELECTION);
    }, [preferences, targets, currentNode, targetsNode, updatePreferences]);

    const value = useMemo(() => {
        const list = targets ?? [];
        /**
         * Whether that empty list is a placeholder or the best answer there is
         * going to be. queryTargetId narrows the first requests by the stored
         * chip while an answer is still due; once the fetch has failed none is,
         * and handing it the placeholder puts those readers back exactly where
         * they are today - unfiltered - rather than filtered by an unverified
         * id with no chip row on screen to clear it.
         */
        const answerPending = targets === null && !targetsFailed;

        return {
            /**
             * Whether the list is an answer rather than a placeholder.
             *
             * Read by the wizard decision and deliberately by nothing that
             * renders or fetches. reloadTargets swallows a failed fetch on
             * purpose and only a node or a permission change retries it, so
             * this stays false for the rest of the session after one 503 from
             * in front of a restarting container or one ten-second timeout:
             * `if (!loaded) return <></>` in the row list, or a fetch gated on
             * it, turns that into a permanently empty dashboard with no way
             * back. It would also put the target fetch in front of the first
             * page of tests for everybody, which is a round trip of blank added
             * to every load. The answers that would have been waited for are
             * made right before the list arrives instead - see queryTargetId.
             */
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
             *
             * Two answers rather than one, because they are wanted at different
             * moments. This is the one the pages narrow their requests by, and
             * it trusts the stored chip while the list is still on its way -
             * see queryTargetId for why a guess belongs there, what a wrong one
             * costs, and why a failed fetch ends it. It is the verified answer
             * again from the moment the list lands, which is before the chip
             * row or the row dots can read it: both are drawn only once there
             * are two targets.
             */
            selectedTarget: queryTargetId(preferences, answerPending ? null : list, currentNode),
            /**
             * The same selection with the guess taken out: null until the list
             * has arrived and confirmed the chip still names a target of this
             * instance.
             *
             * What the export reads. Every other consumer re-asks its question
             * as often as the answer changes, so a guess costs it one repeated
             * request; the export writes a file the operator keeps, and a
             * guessed filter that turned out to name a deleted target would
             * hand them an empty backup with nothing on screen to say why.
             */
            confirmedTarget: selectedTargetId(preferences, list, currentNode),
            /**
             * And the target a whole page is showing, which is not the same
             * question - see pageTarget.
             *
             * Handed out as a function because the last input is not this
             * provider's to give: which targets the rows behind a page's
             * figures actually belong to is something only that page's payload
             * says. The list, the preference and the node are answered here,
             * the evidence is passed in, and the judgement itself stays in the
             * one place that can be tested without a browser.
             */
            pageTargetFor: (presentTargetIds) =>
                pageTarget(list, preferences, currentNode, presentTargetIds),
            // What the chip row writes, so the node it was chosen on travels
            // with it.
            selectionFor: (id) => ({selectedTarget: id, selectedTargetNode: currentNode ?? null}),
            reloadTargets
        };
    }, [targets, targetsFailed, preferences, currentNode, reloadTargets]);

    return (
        <TargetsContext.Provider value={value}>
            <WelcomeDialog open={welcomeShown} onClose={() => setWelcomeShown(false)}/>
            {children}
        </TargetsContext.Provider>
    );
};

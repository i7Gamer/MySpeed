import "./styles.sass";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown,
    faArrowUp,
    faCircleNotch,
    faClock,
    faClose,
    faEllipsisVertical,
    faExclamationTriangle,
    faKey,
    faPen,
    faServer,
    faTableTennisPaddleBall,
    faTrash
} from "@fortawesome/free-solid-svg-icons";
import React, {useContext, useEffect, useRef, useState} from "react";
import {NodeContext} from "@/common/contexts/Node";
import {useAlert} from "@/common/contexts/Alert";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {assertOk, baseRequest} from "@/common/utils/RequestUtil";
import {promptUntilAccepted} from "@/common/utils/PasswordPrompt";
import {t} from "i18next";
import {Trans} from "react-i18next";
import {getIconBySpeed, isFailedTest} from "@/common/utils/TestUtil";
import {resolveLimits} from "@/common/utils/TargetUtil";
import {clickable} from "@/common/utils/Clickable";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {formatLatency, formatWhole, formatWithUnit, getSpeedUnit, wholeSpeed} from "@/common/utils/FormatUtil";
import {useNavigate} from "react-router-dom";
import ContextMenu from "@/common/components/ContextMenu";

// How often a visible card re-reads its node. Named rather than inline because
// the tick's cost is up to three requests per card, proxied to the child for a
// remote one - see the visibility guard below.
const POLL_INTERVAL_MS = 10000;

// What a node from before per-target optima answers when this card asks for
// them: /targets arrived in 1.5.0, so anything older has no such route at all.
// readTargets reads it as "there is nothing here to grade against" rather than
// as a node in trouble - see the docblock there.
const NOT_FOUND = 404;

// How long a node that answered 404 is left alone before being asked again.
// Exported so the suite times its own clock against the same number rather
// than a second copy of it - see the ref that holds the deadline.
const MINUTE_MS = 60 * 1000;
export const TARGETS_RECHECK_MS = 5 * MINUTE_MS;

export const NodeContainer = (node) => {
    const updateNodes = useContext(NodeContext)[1];
    const updateCurrentNode = useContext(NodeContext)[3];
    const reloadConfig = useContext(ConfigContext)[1];
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);
    // One place, so the two speeds cannot drift apart: converted to the unit
    // the reader chose and rounded ONCE, then labelled. The card used to
    // round what it stored and convert afterwards - an eighth of a rounded
    // figure - and then to round the two-decimal conversion again, which
    // printed every [8n+3.96, 8n+4) band one megabyte high. wholeSpeed is the
    // rounded eighth, from the raw quotient.
    const speedText = (mbps) => formatWithUnit(wholeSpeed(mbps, preferences), speedUnit);
    const updateToast = useContext(ToastNotificationContext);
    const alert = useAlert();
    const [nodeData, setNodeData] = useState(null);
    const [nodeError, setNodeError] = useState(undefined);
    const [contextMenu, setContextMenu] = useState(null);
    const menuButton = useRef(null);

    /**
     * Which read of the node is the newest, and which one has already written
     * to the card. NodeContext's pair, and here for the same reason.
     *
     * A read has three triggers - the ten second tick, the visibility listener
     * and the password dialog - and not one of them waits for the one before,
     * so two are routinely in flight at once. baseRequest gives up after ten
     * seconds, which is exactly one tick, so an overtake is the ordinary case
     * rather than a contrived one: whichever read settled last decided what the
     * card said. That is a card gone red over a node that answered a moment
     * ago, or - worse, because switchNode is gated on it - green over one that
     * has since gone down.
     *
     * The applied counter beside the issued one, for the reason NodeContext
     * states: a read that writes nothing must not claim the newest generation,
     * or a good answer arriving behind it would be discarded and the card would
     * keep whatever the failure left on it.
     */
    const requestGeneration = useRef(0);
    const appliedGeneration = useRef(0);

    /**
     * When this node may be asked for its targets again, after answering 404.
     *
     * A window rather than the latch StatusContext keeps over /status/live,
     * and the difference is what the two answers mean. "This build has no
     * /status/live" is a fact about a binary that cannot change under a
     * running page; "this node has no /targets" is a fact about a *remote*
     * node, which can be upgraded while this page is open - and a permanent
     * latch would go on grading its rows against the instance-wide optima for
     * as long as nobody reloads, wearing a colour the dashboard it switches to
     * disagrees with. A 404 that was never about the route at all - a proxy
     * answering for a child mid-restart - latches the same way, and that one
     * does not even correct itself on an upgrade.
     *
     * The window keeps what the latch was for. This card polls every ten
     * seconds for as long as the page is open, so asking an old node on every
     * tick is one wasted request - proxied to the child for a remote node -
     * and one console 404 every ten seconds, forever. Five minutes turns that
     * into one of each, and bounds by the same number how long an upgraded
     * node stays graded against optima that are not its.
     *
     * A ref rather than state: nothing on screen changes with it, and a card
     * that re-rendered on the answer would re-render on every poll.
     */
    const targetsRetryAt = useRef(0);

    const navigate = useNavigate();

    const prefix = node.currentNode ? "" : "/nodes/" + node.id;

    /**
     * The node's own targets, keyed by id - or nothing at all, which is an
     * ordinary answer rather than a failure.
     *
     * That is what separates this read from the two beside it. The route did
     * not exist before 1.5.0, so an older node answers 404, and the
     * `if (!request.ok) return setNodeError(...)` idiom the rest of this
     * function is built on would paint a running node red and make switchNode
     * refuse to navigate to it. A 404, a 401, a dropped connection and a body
     * that is not a list all say the same thing - no per-target optima are
     * known here - and grading by the instance-wide settings is exactly what
     * this card did before targets existed.
     *
     * TargetsContext holds this very map and is deliberately not used for it.
     * That context fetches through getApiRoot(), so it follows the node being
     * *viewed*: on the "this server" card, with a remote node selected, its map
     * would grade a local test against another instance's optima - a worse
     * fault than the one this read exists to fix. Every card asks its own
     * prefix, the way it already asks for its own tests and its own config.
     */
    const readTargets = async (generation) => {
        if (Date.now() < targetsRetryAt.current) return {};

        try {
            const request = await baseRequest(prefix + "/targets");

            // Held off rather than given up on, for the reason the ref above
            // states: a remote node can gain the route between two polls.
            //
            // And only on the newest read's word. This runs outside the
            // claim() that decides whether a read may touch the card, so a
            // read a newer one had already overtaken could arm the window
            // over an answer that had just found the route - and the next
            // poll then skipped /targets and regraded the node's rows
            // against the instance-wide optima. Two reads in flight is the
            // ordinary case here, which is what the counter is for.
            if (request.status === NOT_FOUND) {
                if (generation === requestGeneration.current)
                    targetsRetryAt.current = Date.now() + TARGETS_RECHECK_MS;

                return {};
            }

            if (!request.ok) return {};

            const targets = await request.json();
            if (!Array.isArray(targets)) return {};

            // An answer is the route being there, whichever read got it, so
            // a window left by an earlier 404 goes now rather than in five
            // minutes. The two directions together are what keep an
            // overtake from deciding this either way.
            targetsRetryAt.current = 0;

            return Object.fromEntries(targets.map((target) => [target.id, target]));
        } catch {
            return {};
        }
    };

    const readNode = async (generation) => {
        /**
         * Whether this read is still the newest - and, if it is, that it is now
         * the one that has written.
         *
         * Claimed rather than merely checked, because a read writes twice: the
         * error is cleared and the data set in the same breath, and a newer
         * answer landing between them would leave the two disagreeing.
         */
        const claim = () => {
            if (generation <= appliedGeneration.current) return false;

            appliedGeneration.current = generation;
            return true;
        };

        const fail = (reason) => {
            if (claim()) setNodeError(reason);
        };

        const testRequest = await baseRequest(prefix + "/speedtests?limit=1");

        if (testRequest.status === 401) return fail("PASSWORD_CHANGED");
        if (!testRequest.ok) return fail("SERVER_NOT_REACHABLE");
        const tests = await testRequest.json();

        // Asked for together: neither answer decides anything about the other,
        // so the tick pays one round trip for the pair rather than two, and the
        // await point the targets read adds does not widen the window the
        // generation above exists to survive.
        const [configRequest, targetsById] = await Promise.all([
            baseRequest(prefix + "/config"),
            readTargets(generation)
        ]);

        if (configRequest.status === 401) return fail("PASSWORD_CHANGED");
        if (!configRequest.ok) return fail("SERVER_NOT_REACHABLE");
        const config = await configRequest.json();

        if (config.viewMode) return fail("PASSWORD_CHANGED");

        // Cleared before the early return, not after it. Every healthy branch
        // of the card is gated on !nodeError, so a node that recovered but had
        // not recorded a test yet kept whatever error the last poll set - on
        // every poll, forever. The card stayed red and switchNode refused to
        // navigate; for PASSWORD_CHANGED it re-prompted for a password that
        // was already correct.
        if (tests[0] === undefined) {
            if (!claim()) return;

            setNodeError(undefined);
            return setNodeData({pending: true});
        }

        if (!claim()) return;

        setNodeError(undefined);

        // The figure the colour is read off, which is not the figure the card
        // prints. The overview grades a ping at one decimal, and this card has
        // to agree with the page it switches to: getIconBySpeed floors a
        // percentage, so a ping graded on its way to a whole number would wear
        // one colour here and another there. One measurement changing colour
        // between two views of it is the worse of the two faults - the same
        // trade the overview row makes for the same reason.
        const ping = formatLatency(tests[0]?.ping);

        /**
         * What this test is graded against: its own target's optimal values
         * where the operator set them, this node's instance-wide settings
         * everywhere else - a row that names no target, a target since deleted,
         * and a node too old to have been asked at all.
         *
         * The same resolver the overview row, the detail pane and the
         * latest-test card use, which is the whole point: this card read
         * config.ping, config.download and config.upload directly and never
         * looked at the row's target, so with instance optima of {10, 1000,
         * 500} and a target carrying its own {30, 100, 40} a 24 ms / 95 / 38
         * test wore three red glyphs here and three green ones on the page the
         * card switches to.
         */
        const limits = resolveLimits(targetsById[tests[0]?.targetId], config);

        setNodeData({
            // A failed test carries -1 in every column. Printing those as
            // "-1 ms" and "-1 Mbps" presented the placeholders as readings, so
            // the card marks the failure the way the overview does instead.
            failed: isFailedTest(tests[0]),
            // Whole, like every other list row - see formatWhole.
            ping: formatWhole(tests[0]?.ping),
            // The speeds are stored as they were measured and rounded by
            // speedText at render: the conversion to MB/s has to come first,
            // and the unit is a preference this function never reads.
            download: tests[0]?.download,
            upload: tests[0]?.upload,
            pingIcon: getIconBySpeed(ping, limits.ping, false),
            downloadIcon: getIconBySpeed(tests[0]?.download, limits.download, true),
            uploadIcon: getIconBySpeed(tests[0]?.upload, limits.upload, true)
        });
    }

    /**
     * One read of the node, and the only way in.
     *
     * The generation is claimed out here rather than inside the read so that a
     * rejection is gated by it too. baseRequest rejects on a dropped connection
     * and on its own ten second abort, and this was caught at each of the two
     * call sites - where the handler had no way of telling that a later read
     * had already answered, so a tick that gave up painted the card unreachable
     * over an answer that said the node is fine. Caught in the one place, the
     * way NodeContext catches for its eight callers.
     */
    const updateData = () => {
        const generation = ++requestGeneration.current;

        return readNode(generation).catch(() => {
            if (generation <= appliedGeneration.current) return;

            appliedGeneration.current = generation;
            setNodeError("SERVER_NOT_REACHABLE");
        });
    }

    // The shared ask-again loop rather than a hand-rolled recursion, so this
    // prompt cannot drift apart from the admin login's - see PasswordPrompt.
    const updatePassword = () => promptUntilAccepted(
        (previous) => alert.openInput(t("nodes.password_outdated"), {
            inputType: "password",
            // Required, like the admin login's prompt. Without it an empty
            // answer reads as a cancel, so a stray Enter closed the prompt with
            // nothing said and the card left in its error state.
            required: true,
            description: previous
                ? <span className="icon-red">{t("dialog.password.wrong")}</span>
                : t("nodes.update_password"),
            placeholder: t("dialog.password.placeholder"),
            buttonText: t("dialog.update")
        }),
        async (password) => {
            let res;

            // promptUntilAccepted catches nothing and this loop is started from
            // a bare call, so a rejection here was an unhandled rejection and
            // the prompt simply disappeared. baseRequest rejects on a dropped
            // connection and on its own ten second abort, and .json() rejects on
            // any body that is not JSON. Neither is a wrong password, so the
            // loop ends with the reason on screen rather than asking again.
            try {
                res = await (await baseRequest(`/nodes/${node.id}/password`, "PATCH", {password})).json();
            } catch {
                updateToast(t("nodes.messages.not_reachable"), "red", faExclamationTriangle);
                return {ok: true};
            }

            // A node too busy to check the password has not rejected it, and
            // re-asking would tell the operator a correct password is wrong for
            // as long as the child stays busy. Reported as what it is, and the
            // prompt closes rather than looping.
            if (res.type === "NODE_BUSY") {
                updateToast(res.message, "red", faExclamationTriangle);
                return {ok: true};
            }

            if (res.type !== "PASSWORD_UPDATED") return {ok: false};

            updateData();
            updateToast(t("nodes.password_updated"), "green", faKey);
            return {ok: true};
        }
    );

    useEffect(() => {
        // The card's own name for one read, so the three triggers below read as
        // one thing. updateData catches its own rejection now, so there is
        // nothing left for this to add.
        const load = () => updateData();

        load();
        // Not while nobody is looking. Every tick is up to three requests, and
        // for a remote card each is proxied through this instance to the child
        // - so a dashboard left open on the node list asked six idle nodes some
        // 4,300 times an hour, against the very request budget the status
        // poll's own comment exists to protect. StatusContext has skipped
        // hidden ticks all along; the first load above is not a tick, because
        // opening the page has to fill the card in.
        const interval = setInterval(() => {
            if (!document.hidden) load();
        }, POLL_INTERVAL_MS);
        // The other half of the skip, and what makes it safe: a node that went
        // down while the tab was hidden would otherwise still be green on
        // return, and switchNode is gated on nodeError - so a click navigates
        // the whole app to a node that is down. Chrome throttles background
        // timers, so the tick that would correct it can be a minute away. Every
        // sibling that skips hidden ticks pairs it with this.
        const onVisibilityChange = () => {
            if (!document.hidden) load();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            clearInterval(interval);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
        // One poller for the life of the card. `updateData` is rebuilt on every
        // render, so listing it would tear the interval down and start a new one
        // each time - and since updateData sets state, the ten seconds would
        // never elapse.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const switchNode = () => {
        if (nodeError || !nodeData) {
            if (nodeError === "PASSWORD_CHANGED") updatePassword();
            return;
        }

        navigate("/");
        updateCurrentNode(node.id);
        reloadConfig();
    }

    const onContext = async (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (node.currentNode) return;

        setContextMenu({x: event.clientX, y: event.clientY});
    };

    /**
     * The same menu, from a control that can be seen and reached.
     *
     * Renaming and deleting a server used to be behind the right mouse button
     * and nothing else: no affordance on the card, nothing in a dialog, and
     * nothing announced - so on a touch screen the two actions did not exist,
     * and a screen reader was never told they did.
     *
     * Anchored under the button rather than at a pointer that has no position
     * when the key was Enter. The menu takes the button's ref so that opening
     * it does not count as a click outside itself.
     */
    const toggleContextMenu = (event) => {
        event.preventDefault();
        event.stopPropagation();

        setContextMenu((open) => {
            if (open) return null;

            const box = event.currentTarget.getBoundingClientRect();
            return {x: box.left, y: box.bottom};
        });
    };

    const closeContextMenu = () => setContextMenu(null);

    const handleRename = async () => {
        const newName = await alert.openInput(t("nodes.rename.title"), {
            placeholder: t("nodes.rename.placeholder"),
            buttonText: t("dialog.save"),
            value: node.name
        });

        if (newName && newName !== node.name) {
            // Checked before reporting success: the mutating helpers return the
            // raw response, so a refused rename used to show the success toast
            // and leave the old name on screen.
            //
            // baseRequest, as the password patch and the delete beside it use:
            // this path already names the node, and patchRequest prepends the
            // node currently being *viewed*. With any remote node selected the
            // rename went to /api/nodes/<viewed>/nodes/<renamed>/name and was
            // answered by nothing. From the local instance the two roots agree,
            // which is why it looked like it worked.
            try {
                await assertOk(await baseRequest(`/nodes/${node.id}/name`, "PATCH", {name: newName}), "rename node");
            } catch (e) {
                updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
                return;
            }

            updateToast(t("nodes.rename.success"), "green", faPen);
            updateNodes();
        }
    };

    const handleDelete = async () => {
        const confirmed = await alert.openConfirm(
            t("nodes.delete.title"),
            <Trans components={{Bold: <span className="dialog-value"/>}}
                   values={node}>nodes.delete.description</Trans>,
            {
                buttonText: t("nodes.delete.yes"),
                danger: true
            }
        );

        if (confirmed) {
            try {
                await assertOk(await baseRequest("/nodes/" + node.id, "DELETE"), "delete node");
            } catch (e) {
                updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
                return;
            }

            updateToast(t("nodes.delete.success"), "green", faServer);
            updateNodes();
        }
    };

    const contextMenuItems = [
        {
            icon: faPen,
            label: t("nodes.rename.title"),
            onClick: handleRename
        },
        {divider: true},
        {
            icon: faTrash,
            label: t("nodes.delete.title"),
            onClick: handleDelete,
            danger: true
        }
    ];

    return (
        <>
            {contextMenu && (
                <ContextMenu
                    items={contextMenuItems}
                    position={contextMenu}
                    onClose={closeContextMenu}
                    label={t("nodes.context_menu")}
                    trigger={menuButton}
                />
            )}
            <div className={"node-item hover-" + (nodeError ? "red" : (nodeData ? "green" : "orange"))} key={node.id}
                 {...clickable(switchNode)} onContextMenu={onContext}>
                <div className="node-info-area">
                    <FontAwesomeIcon icon={faServer}
                                     className={"icon-" + (nodeError ? "red" : (nodeData ? "green" : "orange"))}/>
                    <div className="node-info">
                        <h1>{node.name}</h1>
                        <p>{node.url.replace(/(^\w+:|^)\/\//, '')}</p>
                    </div>
                    {/* Not on the current server's own card, which has nothing
                        to rename or delete - the same condition the right-click
                        handler applies. */}
                    {!node.currentNode && (
                        <button type="button" className="node-menu-button" ref={menuButton}
                                aria-label={t("nodes.context_menu")} aria-haspopup="menu"
                                aria-expanded={contextMenu !== null}
                                onClick={toggleContextMenu}>
                            <FontAwesomeIcon icon={faEllipsisVertical}/>
                        </button>
                    )}
                </div>
                <div className="speed-area">

                    {nodeError === "SERVER_NOT_REACHABLE" && (<div className="icon-text">
                        <h2>{t("nodes.messages.not_reachable")}</h2>
                        <FontAwesomeIcon icon={faExclamationTriangle} className="speed-icon icon-red"/>
                    </div>)}

                    {nodeError === "PASSWORD_CHANGED" && (<div className="icon-text">
                        <h2>{t("nodes.messages.password_changed")}</h2>
                        <FontAwesomeIcon icon={faKey} className="speed-icon icon-red"/>
                    </div>)}

                    {!nodeError && !nodeData && (
                        <FontAwesomeIcon icon={faCircleNotch} className="speed-icon" spin={true}/>)}

                    {nodeData && nodeData.pending && !nodeError && (<div className="icon-text">
                            <h2>{t("nodes.messages.tests_pending")}</h2>
                            <FontAwesomeIcon icon={faClock} className="speed-icon icon-blue"/>
                        </div>)}

                    {/* The node is answering - it is its last test that failed,
                        so this reads as a result rather than as the node being
                        down, and carries the same X the overview marks a failed
                        test with. */}
                    {nodeData && nodeData.failed && !nodeData.pending && !nodeError && (<div className="icon-text">
                        <h2>{t("test.failed")}</h2>
                        <FontAwesomeIcon icon={faClose} className="speed-icon icon-error"/>
                    </div>)}

                    {nodeData && !nodeData.failed && !nodeData.pending && !nodeError && (
                        <>
                            {/* Each measurement publishes its grade on its own
                                item, so any part of it can be opted into showing
                                the colour - the glyph does today, and the figure
                                follows when the app is set to state it twice.
                                See the graded-value mixin. */}
                            <div className="speed-item" data-grade={nodeData.pingIcon}>
                                <FontAwesomeIcon icon={faTableTennisPaddleBall}
                                                 className={"icon-" + nodeData.pingIcon}/>
                                <h1>{formatWithUnit(nodeData.ping, t("latest.ping_unit"))}</h1>
                            </div>

                            <div className="speed-item" data-grade={nodeData.downloadIcon}>
                                <FontAwesomeIcon icon={faArrowDown}
                                                 className={"icon-" + nodeData.downloadIcon}/>
                                <h1>{speedText(nodeData.download)}</h1>
                            </div>

                            <div className="speed-item" data-grade={nodeData.uploadIcon}>
                                <FontAwesomeIcon icon={faArrowUp}
                                                 className={"icon-" + nodeData.uploadIcon}/>
                                <h1>{speedText(nodeData.upload)}</h1>
                            </div>
                        </>
                    )}
                </div>

            </div>
        </>
    );
}
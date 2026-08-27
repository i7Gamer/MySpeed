import speedTest, { isShuttingDown } from '../util/speedtest.js';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import * as controller from "../controller/recommendations.js";
import * as parseData from '../util/providers/parseData.js';
import { setState, sendRunning, sendError, sendFinished } from "./integrations.js";
import * as serverController from "../controller/servers.js";
import { toErrorMessage } from '../util/helpers.js';
import { PHASE_ORDER, PHASE_START, overallProgress } from '../util/providers/progress.js';
import { failedPayload, finishedPayload } from '../util/notificationPayload.js';
import { FAILED_TEST, UNMEASURED_LATENCY, impossibleMeasurement, isFailedTest, isMeasuredLatency, usableFigure }
    from '../util/testOutcome.js';
import { isRateLimitMessage } from '../util/providers/cliOutput.js';
import { backoffRemainingMs, clearBackoff, recordRateLimit } from '../util/rateLimitBackoff.js';
import * as targetsController from '../controller/targets.js';

// The placeholder a failed test stores in every numeric column. The client
// tells a failure apart by it, so it is not a value anyone should read as one.
// Taken from the module that owns the judgement rather than declared again:
// this is the writer, and the alert gate is a reader whose correctness depends
// on the two matching.
const FAILED = FAILED_TEST;

let _isRunning = false;

// What the run currently in flight is doing. Only ever read through
// getProgress(), and reset the moment a run ends so a finished test cannot
// leave a stale bar sitting at 80% until the next one starts.
// Progress is null rather than 0 until a provider actually reports some. Only
// the Ookla CLI does: librespeed's --json suppresses its verbose output and
// cfspeedtest's silences everything but the result, so those runs never report
// a fraction at all and must not be drawn as one sitting at zero.
// `target` names the round member currently measuring - null outside a round
// and on instances from before targets existed, so every added field is
// additive and /status keeps its shape for an older reader.
const NO_PROGRESS = {phase: null, progress: null, speed: null, startedAt: null, target: null};

let _progress = {...NO_PROGRESS};

export const getProgress = () => ({..._progress});

const updateProgress = ({phase, progress, speed}) => {
    _progress = {
        phase,
        progress: overallProgress(phase, progress),
        // The latency phase measures no throughput, so it reports none rather
        // than leaving the previous phase's figure on screen.
        speed: speed ?? null,
        startedAt: _progress.startedAt,
        target: _progress.target
    };
};

/**
 * Marks the next round member as the one measuring. The phase and fraction
 * start over - they describe this target's run, not the round - while
 * startedAt keeps the round's own beginning, which is what the elapsed
 * counter in the status bar counts.
 */
const beginTarget = (target, index, count) => {
    _progress = {
        ..._progress,
        phase: PHASE_START,
        progress: null,
        speed: null,
        target: target.id === null ? null : {id: target.id, name: target.name, index, count}
    };
};

const setRunning = (running, sendRequest = true) => {
    _isRunning = running;

    if (running) {
        _progress = {...NO_PROGRESS, phase: PHASE_START, startedAt: new Date().toISOString()};
        setState("running");
        // Caught with context, the way sendFinished and sendError are. This
        // used to be sent through a bare then with no handler - which handles
        // nothing - so a rejection here, the same database read that can fail
        // inside triggerEvent, escaped to the process-level hook and was
        // logged as a bare server fault naming nothing.
        if (sendRequest) sendRunning().catch(err =>
            console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
    } else {
        _progress = {...NO_PROGRESS};
        setState("ping");
    }
}

// How many successful tests the recommended targets are read from. Fewer says
// too little about the line to recommend anything.
const RECOMMENDATION_SAMPLE = 10;

// What a ping has to be before it counts as something that was measured: a
// reading, and a positive one. FAILED sits below every real latency, so a failed
// row that reaches the sample anyway - one whose error column somehow stayed
// null - would otherwise take "lowest ping" from every genuine test beside it,
// and the fabricated zero above it would do the same. Asked through
// isMeasuredLatency rather than spelled again here: the statistics and the alert
// gate judge this exact question, and a third answer is what put a 0 ms target
// on the recommendation card beside a page that would not average the same row.
const lowestRealPing = (ping) => isMeasuredLatency(ping) && ping > UNMEASURED_LATENCY;

/**
 * Exported for its tests. Filtering failures out of listTests() - whose default
 * limit is 10 rows *including* failures - meant one failed test among the
 * newest ten shrank the sample below the required size, and the recommendations
 * silently stopped updating until the failure aged out of the newest page.
 */
export const createRecommendations = async () => {
    // The sample describes one line, so it comes from one target: the first
    // scheduled one that takes part in alerting. A gigabit LAN box mixed into
    // the sample would recommend numbers no WAN target can meet.
    const primary = await targetsController.alertsTarget();
    if (!primary) return;

    const list = await tests.listSuccessful(RECOMMENDATION_SAMPLE, primary.id);
    if (list.length < RECOMMENDATION_SAMPLE) return;

    let recommendations = {ping: Infinity, down: 0, up: 0};
    for (const entry of list) {
        const {ping, download, upload} = entry;

        // Number.isFinite with no typeof beside it: it coerces nothing, so every
        // non-number is already out. That matters because sqlite keeps whatever
        // it was handed, and a history imported before importTests() checked its
        // numeric columns can still hold an empty string in one - which compares
        // as zero and so took "lowest ping" from the whole sample.
        if (lowestRealPing(ping) && ping < recommendations.ping)
            recommendations.ping = ping;

        if (Number.isFinite(download) && download > recommendations.down)
            recommendations.down = download;

        if (Number.isFinite(upload) && upload > recommendations.up)
            recommendations.up = upload;
    }

    // Nothing in the sample measured a latency, so there is nothing to
    // recommend. Falling through handed the untouched Infinity to the
    // controller, whose Math.round() passes it along unchanged, and the row came
    // back with a null ping beside a perfectly good download and upload.
    if (!Number.isFinite(recommendations.ping)) return;

    await controller.update(recommendations.ping, recommendations.down, recommendations.up);
}

/** How long the demo pretends a test takes. */
export const PREVIEW_RUN_MS = 5000;

// Enough steps that the bar visibly glides, spaced widely enough that the
// simulation is not busywork - previewProgress.test.js holds the two apart.
const PREVIEW_STEPS_PER_PHASE = 4;

/**
 * The march the demo bar makes, as data. Exported for its tests.
 *
 * The real phases in their real order, each walked to completion, with no
 * speed - a figure for a measurement that never happened would be the bar
 * lying rather than pretending. The latency phase of a real run reports the
 * same null.
 */
export const previewProgressSteps = () =>
    PHASE_ORDER.flatMap((phase) => Array.from({length: PREVIEW_STEPS_PER_PHASE},
        (_, step) => ({phase, progress: (step + 1) / PREVIEW_STEPS_PER_PHASE, speed: null})));

const simulatePreviewRun = async () => {
    const steps = previewProgressSteps();
    const stepMs = PREVIEW_RUN_MS / steps.length;

    for (const step of steps) {
        await new Promise(resolve => setTimeout(resolve, stepMs));
        updateProgress(step);
    }
};

/**
 * Which server a run measures against: the target's own backend where it has
 * one, the server it pins where it pins one, and whatever the provider chooses
 * otherwise.
 *
 * `retryAuto` is the automatic second attempt, and what it drops is the *pin*.
 * That is what the fallback is for - a pinned server that has degraded or died
 * fails every run against it, and the retry asks the provider to choose one
 * instead.
 *
 * It does not drop the endpoint, which used to go with it. A pin is a
 * preference among the provider's own servers; an endpoint is which line is
 * being measured. A retry without it measured the *public* fleet and stored the
 * answer under this target's id, so the history said the operator's own backend
 * had delivered a number it never produced - and a target carrying an endpoint
 * records no server id, so nothing on the row said otherwise.
 *
 * Its own function because that is the only way the decision can be tested: the
 * two suites that pin the retry read the source for its condition, and neither
 * could see the arguments it ran with.
 */
export const serversFor = (target, retryAuto = false) => {
    const serverUrl = target.endpoint ?? undefined;

    // An endpoint already names the server, so a pin alongside it would be a
    // second answer to a question that has one.
    if (serverUrl) return {serverId: undefined, serverUrl};

    return {serverId: retryAuto ? undefined : (target.serverId ?? undefined), serverUrl: undefined};
};

export const run = async (target, retryAuto = false) => {
    const mode = target.provider;

    let {serverId, serverUrl} = serversFor(target, retryAuto);

    // The callback is carried whichever server was chosen: the retry is the
    // same logical run, and a bar that stopped moving the moment a test fell
    // back to automatic server selection would read as the run having hung.
    let speedtest = await speedTest(mode, serverId, serverUrl, updateProgress);

    // Recorded on the row, not written back into the configuration. Persisting
    // it turned "choose automatically" into a pin the moment the first test
    // finished: the dialog still offered the option, but selecting it lasted
    // exactly one run, and nothing on screen said the server had been fixed.
    // A pinned server that later degrades makes the line look slower with no
    // explanation, and one that dies costs a full attempt - up to the CLI's
    // three-minute timeout - before the run falls back to automatic.
    if (mode === "ookla" && speedtest.server) {
        serverId = speedtest.server?.id;
    }

    if (mode === "libre" && speedtest.server && !serverUrl) {
        let serverEntry = Object.entries(serverController.getLibreServers())
            .filter(([, value]) => value === speedtest.server.name)[0];

        if (serverEntry) {
            serverId = parseInt(serverEntry[0]);
        }
    }

    if (Object.keys(speedtest).length <= 1) throw {message: "No response, even after trying again, test timed out."};

    return {...speedtest, serverId}
}

/**
 * The stand-in a demo round runs instead of a stored target. Its null id keeps
 * targetId off the fabricated rows, and alerts stays on so a demo behaves the
 * way the single-provider instance always did.
 */
const PREVIEW_TARGET = Object.freeze({id: null, name: null, provider: "preview", alerts: true});

const roundMembers = async (targetId) => {
    if (process.env.PREVIEW_MODE === "true") return [PREVIEW_TARGET];

    if (targetId !== undefined) {
        const one = await targetsController.getOne(targetId);
        return one ? [one] : [];
    }

    return await targetsController.roundTargets();
};

/**
 * Whether the provider is still inside the hold a refusal earned, and says so
 * when it is. Asked per round member rather than once for the round: the holds
 * are per provider, and an Ookla refusal is no reason to skip the iperf3 box
 * standing next to it.
 */
const MS_PER_MINUTE = 60_000;

const heldByBackoff = (provider) => {
    const remaining = backoffRemainingMs(provider);

    if (remaining === 0) return false;

    console.warn(`The ${provider} provider refused the last test for too many requests. `
        + `Skipping its targets this round - trying again in ${Math.ceil(remaining / MS_PER_MINUTE)} minutes.`);

    return true;
};

export const create = async (type = "auto", targetId = undefined) => {
    // The guard has to latch synchronously: POST /speedtests/run no longer awaits
    // this call, so checking after an await would let two requests slip past.
    // One latch for the whole round - targets run strictly in sequence, which
    // is also what keeps util/speedtest.js's single activeProcess invariant.
    if (_isRunning) {
        // Named rather than swallowed. A round of several members can outlast
        // the schedule interval - one unreachable iperf3 target costs two CLI
        // timeouts before the round moves on - and a tick dropped in silence
        // looks from the outside exactly like the scheduler having stopped:
        // no failed row, nothing in the log, and /status still reporting a run
        // in progress. The tick is still dropped; it just says so.
        console.warn("A speedtest round is still running - skipping this scheduled one.");
        return 500;
    }
    _isRunning = true;

    try {
        return await executeRound(type, targetId);
    } finally {
        // The one guarantee that the latch is dropped however this ends. It
        // used to be cleared only on the paths that were thought of, so a throw
        // from the failure handler - which is where a broken database or a
        // failing notification surfaces - wedged every later speedtest.
        _isRunning = false;
    }
}

const executeRound = async (type, targetId) => {
    const members = await roundMembers(targetId);

    if (members.length === 0) return 400;

    // Once per round, however many members it has: the integrations hear one
    // "running", and the progress clock starts here. A pretended run tells
    // them nothing - a demo has no business firing anybody's webhook.
    setRunning(true, members[0].provider !== "preview");

    try {
        for (const [index, target] of members.entries()) {
            // The shutdown has just killed the member in flight, and the round
            // is what carries on past it: the next target spawns a CLI after
            // the one moment terminateActiveProcess could reach it - the orphan
            // trackProcess exists to prevent, rebuilt one member further along -
            // and writes its result into a handle onCleanup has closed.
            //
            // Above beginTarget rather than below it: that is what /status
            // reads to name the target measuring, and stopping underneath it
            // leaves the bar advertising a member the round never started.
            if (isShuttingDown()) break;

            beginTarget(target, index + 1, members.length);

            // Only the scheduled rounds honour a hold - a test started by hand
            // is somebody asking for one now. The skip is per target, so the
            // rest of the round still runs.
            if (type === "auto" && heldByBackoff(target.provider)) continue;

            await executeTarget(target, type);
        }
    } finally {
        // The round is over on every path, including a throw from a member's
        // failure handler - the same guarantee the latch has, for the same
        // reason: tasks/integrations.js reads this state for its keep-alive.
        setRunning(false, false);
    }
};

const executeTarget = async (target, type, retried = false) => {
    const mode = target.provider === "preview" ? "preview" : target.provider;

    try {
        let test;
        if (mode === "preview") {
            await simulatePreviewRun();
            test = {
                ping: {latency: Math.floor(Math.random() * 25) + 5, jitter: Math.random() * 5 + 0.5},
                download: {bandwidth: 125 * 100000 * (Math.random() + 0.5), elapsed: 10000},
                upload: {bandwidth: 125 * 100000 * (Math.random() + 0.5), elapsed: 10000},
            }
        } else {
            test = await run(target, retried);
        }

        // The parser names the provider itself, so the row cannot end up
        // attributed to one that did not produce it - including under preview
        // mode, where the generated result is ookla-shaped whatever is configured.
        let {ping, jitter, download, upload, time, resultId, serverName, serverHost, serverLocation,
            packetLoss, downloadLatency, uploadLatency, isp, externalIp, provider,
            bytesDownloaded, bytesUploaded} = await parseData.parseData(mode === "preview" ?
            parseData.OOKLA : mode, test);

        /*
         * A parse that produced no measurement is a failed run, whatever the
         * CLI's exit code said.
         *
         * parseCloudflare is total by design - it keeps the edge and the
         * external IP when the measurement block never arrived - so it answers
         * the failure placeholders rather than throwing, and this path had no
         * idea. The row went in with `error` left NULL, createRecommendations
         * was handed it, healthchecks.io was pinged on the success endpoint and
         * every webhook was told the test completed at -1 Mbps, while every
         * reader of the stored row called it a failure. Thrown here, it takes
         * the one path that writes the error text, sends sendError, and retries
         * once - which a run that reached an edge and measured nothing deserves.
         */
        if (isFailedTest({ping, download, upload}))
            throw new Error(`${mode} finished without reporting any measurement`);

        /*
         * And a run that reported something impossible leaves by the same door -
         * upstream #875, and on the evidence of its screenshot #792.
         *
         * The check above asks whether all three came back as the placeholder,
         * so one negative upload beside two good figures was a failure by no
         * reading and went in as an ordinary result. From there every reader
         * believed it: the average, the grade, the export, and the alert gate,
         * which reads a measurement far below the threshold as an outage.
         *
         * Thrown rather than clamped, because zero is not what was measured
         * either - nobody knows what the line did. It takes the same path an
         * unmeasurable run takes: the reason is written down, the integrations
         * are told the test failed, and it is retried once, which a run that
         * came back with a negative reading deserves as much as one that came
         * back with nothing.
         */
        const impossible = impossibleMeasurement({ping, download, upload});

        if (impossible)
            throw new Error(`${mode} reported an impossible ${impossible}: ${{ping, download, upload}[impossible]}`);

        const serverId = test.serverId;

        // The provider is answering again, so whatever hold a previous refusal
        // earned is over - including the escalation, which a completed test is
        // the only thing that disproves.
        if (mode !== "preview") clearBackoff(mode);

        /*
         * The nullable figures ask a different question and get a different
         * answer: null already means "nobody measured this", so a negative one
         * has an honest home to go to. Failing the whole run over a jitter of
         * -0.2 would throw away a throughput measurement that is perfectly good,
         * which is the opposite of what the guard above is for.
         */
        let testResult = await tests.create({ping, download, upload, time, serverId, type,
            targetId: target.id,
            resultId, jitter: usableFigure(jitter), serverName, serverHost, serverLocation,
            packetLoss: usableFigure(packetLoss),
            downloadLatency: usableFigure(downloadLatency), uploadLatency: usableFigure(uploadLatency),
            isp, externalIp, provider, bytesDownloaded, bytesUploaded});
        console.log(`Test #${testResult.id}${target.name ? ` (${target.name})` : ""} was executed successfully in ${time}s. 🏓 ${ping} (±${jitter ?? 'N/A'}) ⬇ ${download}️ ⬆ ${upload}️`);
        createRecommendations().catch(err =>
            console.error(`Could not update the recommendations: ${toErrorMessage(err)}`));
        // Everything the row records, not the five figures this used to send:
        // a webhook is how MySpeed feeds anything else, and a consumer that
        // cannot tell which provider or server produced a number can do little
        // with it. A target that opted out of alerting sends nothing - it is
        // the diagnostic box, not the line being watched.
        if (target.alerts) sendFinished(finishedPayload({...testResult, provider, ping, jitter, download, upload, time,
            packetLoss, downloadLatency, uploadLatency, serverId, serverName, serverHost, serverLocation,
            isp, externalIp, resultId, bytesDownloaded, bytesUploaded,
            targetId: target.id, targetName: target.name})).catch(err =>
            console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
    } catch (e) {
        console.log(e)

        // A thrown string or a plain object has no `message`, and storing
        // undefined writes NULL - which marks the row as *successful* and lets
        // its -1 placeholder values poison every average.
        //
        // Read before the retry rather than after it, which is where it used to
        // sit: the retry now has to know what the failure was.
        const message = toErrorMessage(e);

        /*
         * A provider that answered "too many requests" is the one failure a
         * second attempt cannot help with, because the second attempt is the
         * problem - upstream #846 and #1092. Recorded before the retry decision
         * so the hold stands whichever way that goes, and against `mode` because
         * the limiter belongs to the provider that refused rather than to this
         * instance.
         */
        const rateLimited = isRateLimitMessage(message);

        if (rateLimited) recordRateLimit(mode);

        // Not while the process is leaving: the shutdown has just killed the
        // child this failure reports, and a retry would spawn a fresh one after
        // the only moment terminateActiveProcess could reach it - the orphan
        // trackProcess exists to prevent, rebuilt one line further down. The
        // retry is this target's alone: the round carries on to the next
        // member whatever happens here.
        if (!retried && !isShuttingDown() && !rateLimited) return await executeTarget(target, type, true);

        // The provider is recorded on a failure too: nothing was parsed, but
        // which provider could not complete is the first thing a reader of the
        // error wants, and the target may have changed by the time they look.
        let testResult = await tests.create({ping: FAILED, download: FAILED, upload: FAILED, time: null,
            serverId: 0, type, error: message, provider: mode, targetId: target.id});
        // Not awaited, the way the success path above does it. triggerEvent
        // works through the integrations one at a time and each outbound
        // call has a ten second timeout, so a few endpoints that have gone
        // unreachable - the very situation this notification describes -
        // held the run open for the sum of their timeouts.
        if (target.alerts) sendError(failedPayload({...testResult, provider: mode, error: message,
            targetId: target.id, targetName: target.name})).catch(err =>
            console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
        console.log(`Test #${testResult.id} was not executed successfully. Please try reconnecting to the internet or restarting the software: ` + message);
    }
}

export const isRunning = () => _isRunning;

export const removeOld = async () => {
    await tests.removeOld();
};
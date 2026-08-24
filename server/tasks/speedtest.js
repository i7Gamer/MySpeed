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
import { FAILED_TEST, UNMEASURED_LATENCY, isFailedTest, isMeasuredLatency } from '../util/testOutcome.js';
import { isRateLimitMessage } from '../util/providers/cliOutput.js';
import { clearBackoff, recordRateLimit } from '../util/rateLimitBackoff.js';

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
const NO_PROGRESS = {phase: null, progress: null, speed: null, startedAt: null};

let _progress = {...NO_PROGRESS};

export const getProgress = () => ({..._progress});

const updateProgress = ({phase, progress, speed}) => {
    _progress = {
        phase,
        progress: overallProgress(phase, progress),
        // The latency phase measures no throughput, so it reports none rather
        // than leaving the previous phase's figure on screen.
        speed: speed ?? null,
        startedAt: _progress.startedAt
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
    const list = await tests.listSuccessful(RECOMMENDATION_SAMPLE);
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

export const run = async (retryAuto = false) => {
    // The retry is the same logical test, so integrations are told it started
    // once rather than twice.
    setRunning(true, !retryAuto);
    let mode = await config.getValue("provider");

    if (mode === "none") {
        setRunning(false);
        throw {message: "No provider selected"};
    }

    let serverId = mode === "cloudflare" ? 0 : await config.getValue(mode + "Id");
    let serverUrl = mode === "libre" ? await config.getValue("libreUrl") : undefined;

    if (serverId === "none")
        serverId = undefined;
    
    if (serverUrl === "none")
        serverUrl = undefined;

    if (mode === "libre" && serverUrl)
        serverId = undefined;

    // Both branches carry the callback: the retry is the same logical run, and a
    // bar that stopped moving the moment a test fell back to automatic server
    // selection would read as the run having hung.
    let speedtest = await (retryAuto
        ? speedTest(mode, undefined, undefined, updateProgress)
        : speedTest(mode, serverId, serverUrl, updateProgress));

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

export const create = async (type = "auto", retried = false) => {
    // The guard has to latch synchronously: POST /speedtests/run no longer awaits
    // this call, so checking after an await would let two requests slip past.
    if (_isRunning && !retried) return 500;
    if (!retried) _isRunning = true;

    try {
        // Awaited, not returned: a bare return would settle the finally before
        // the retry it hands back has finished.
        return await execute(type, retried);
    } finally {
        // The one guarantee that the latch is dropped however this ends. It
        // used to be cleared only on the paths that were thought of, so a throw
        // from the failure handler - which is where a broken database or a
        // failing notification surfaces - wedged every later speedtest.
        // A retried call shares the outer call's latch and must not clear it.
        if (!retried) _isRunning = false;
    }
}

const execute = async (type, retried) => {
    const mode = await config.getValue("provider");

    if (mode === "none") return 400;

    try {
        let test;
        if (process.env.PREVIEW_MODE === "true") {
            // The same latch a real run sets - run() is the only other caller
            // of setRunning(true), and this branch skips run(), so the demo's
            // whole test used to answer {running: true, phase: null,
            // startedAt: null} on the status endpoint: the instance whose job
            // is showing the interface showed a run reporting nothing. Minus
            // the integration notice, which a pretended test has no business
            // sending.
            setRunning(true, false);
            await simulatePreviewRun();
            test = {
                ping: {latency: Math.floor(Math.random() * 25) + 5, jitter: Math.random() * 5 + 0.5},
                download: {bandwidth: 125 * 100000 * (Math.random() + 0.5), elapsed: 10000},
                upload: {bandwidth: 125 * 100000 * (Math.random() + 0.5), elapsed: 10000},
            }
        } else {
            test = await run(retried);
        }

        // The parser names the provider itself, so the row cannot end up
        // attributed to one that did not produce it - including under preview
        // mode, where the generated result is ookla-shaped whatever is configured.
        let {ping, jitter, download, upload, time, resultId, serverName, serverHost, serverLocation,
            packetLoss, downloadLatency, uploadLatency, isp, externalIp, provider,
            bytesDownloaded, bytesUploaded} = await parseData.parseData(process.env.PREVIEW_MODE === "true" ?
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

        const serverId = test.serverId;

        // The provider is answering again, so whatever hold a previous refusal
        // earned is over - including the escalation, which a completed test is
        // the only thing that disproves.
        clearBackoff(mode);

        let testResult = await tests.create({ping, download, upload, time, serverId, type,
            resultId, jitter, serverName, serverHost, serverLocation, packetLoss, downloadLatency, uploadLatency,
            isp, externalIp, provider, bytesDownloaded, bytesUploaded});
        console.log(`Test #${testResult.id} was executed successfully in ${time}s. 🏓 ${ping} (±${jitter ?? 'N/A'}) ⬇ ${download}️ ⬆ ${upload}️`);
        createRecommendations().catch(err =>
            console.error(`Could not update the recommendations: ${toErrorMessage(err)}`));
        setRunning(false);
        // Everything the row records, not the five figures this used to send:
        // a webhook is how MySpeed feeds anything else, and a consumer that
        // cannot tell which provider or server produced a number can do little
        // with it.
        sendFinished(finishedPayload({...testResult, provider, ping, jitter, download, upload, time,
            packetLoss, downloadLatency, uploadLatency, serverId, serverName, serverHost, serverLocation,
            isp, externalIp, resultId, bytesDownloaded, bytesUploaded})).catch(err =>
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
        // trackProcess exists to prevent, rebuilt one line further down.
        if (!retried && !isShuttingDown() && !rateLimited) return await create(type, true);

        /*
         * The run is over however the rest of this goes.
         *
         * setRunning(false, false) sat at the end, behind the awaited write and
         * the awaited notification, so a rejection from either - a database
         * that has gone away is the realistic one - skipped it. `setState("ping")`
         * then never ran, and tasks/integrations.js was left at
         * `currentState === "running"` for the life of the process: the
         * minutePassed keep-alive that webhook's send_alive and healthChecks
         * depend on stopped firing, silently and permanently, and the progress
         * bar kept a stale phase and startedAt. The success path already clears
         * the flag before its un-awaited notification; this is the same order.
         */
        try {
            // The provider is recorded on a failure too: nothing was parsed, but
            // which provider could not complete is the first thing a reader of the
            // error wants, and the setting may have changed by the time they look.
            let testResult = await tests.create({ping: FAILED, download: FAILED, upload: FAILED, time: null,
                serverId: 0, type, error: message, provider: mode});
            // Not awaited, the way the success path above does it. triggerEvent
            // works through the integrations one at a time and each outbound
            // call has a ten second timeout, so a few endpoints that have gone
            // unreachable - the very situation this notification describes -
            // held the run open for the sum of their timeouts. The finally
            // below still ran, but "the run is over" arrived a minute late, and
            // the next scheduled test was refused for all of it.
            sendError(failedPayload({...testResult, provider: mode, error: message})).catch(err =>
                console.error(`Could not notify the integrations: ${toErrorMessage(err)}`));
            console.log(`Test #${testResult.id} was not executed successfully. Please try reconnecting to the internet or restarting the software: ` + message);
        } finally {
            setRunning(false, false);
        }
    }
}

export const isRunning = () => _isRunning;

export const removeOld = async () => {
    await tests.removeOld();
};
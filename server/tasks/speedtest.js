import speedTest from '../util/speedtest.js';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import * as controller from "../controller/recommendations.js";
import * as parseData from '../util/providers/parseData.js';
import { setState, sendRunning, sendError, sendFinished } from "./integrations.js";
import * as serverController from "../controller/servers.js";
import { toErrorMessage } from '../util/helpers.js';
import { PHASE_START, overallProgress } from '../util/providers/progress.js';
import { failedPayload, finishedPayload } from '../util/notificationPayload.js';
import { FAILED_TEST } from '../util/testOutcome.js';

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
        if (sendRequest) sendRunning().then(undefined);
    } else {
        _progress = {...NO_PROGRESS};
        setState("ping");
    }
}

// How many successful tests the recommended targets are read from. Fewer says
// too little about the line to recommend anything.
const RECOMMENDATION_SAMPLE = 10;

// What a ping has to clear before it counts as something that was measured.
// FAILED sits below every real latency, so a failed row that reaches the sample
// anyway - one whose error column somehow stayed null - would take "lowest
// ping" from every genuine test beside it.
const LOWEST_REAL_PING = FAILED + 1;

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
        if (Number.isFinite(ping) && ping >= LOWEST_REAL_PING && ping < recommendations.ping)
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
            await new Promise(resolve => setTimeout(resolve, 5000));
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

        const serverId = test.serverId;

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
        if (!retried) return await create(type, true);

        // A thrown string or a plain object has no `message`, and storing
        // undefined writes NULL - which marks the row as *successful* and lets
        // its -1 placeholder values poison every average.
        const message = toErrorMessage(e);

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
            await sendError(failedPayload({...testResult, provider: mode, error: message}));
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
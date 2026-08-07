import speedTest from '../util/speedtest.js';
import * as tests from '../controller/speedtests.js';
import * as config from '../controller/config.js';
import * as controller from "../controller/recommendations.js";
import * as parseData from '../util/providers/parseData.js';
import { setState, sendRunning, sendError, sendFinished } from "./integrations.js";
import * as serverController from "../controller/servers.js";
import { toErrorMessage } from '../util/helpers.js';

let _isRunning = false;

const setRunning = (running, sendRequest = true) => {
    _isRunning = running;

    if (running) {
        setState("running");
        if (sendRequest) sendRunning().then(undefined);
    } else {
        setState("ping");
    }
}

const createRecommendations = async () => {
    let list = (await tests.listTests()).filter((entry) => !entry.error);
    if (list.length >= 10) {
        let recommendations = {ping: 1000, down: 0, up: 0};
        for (let i = 0; i < 10; i++) {
            if (list[i].ping < recommendations["ping"]) recommendations["ping"] = list[i].ping;
            if (list[i].download > recommendations["down"]) recommendations["down"] = list[i].download;
            if (list[i].upload > recommendations["up"]) recommendations["up"] = list[i].upload;
        }

        await controller.update(recommendations["ping"], recommendations["down"], recommendations["up"]);
    }
}

export const run = async (retryAuto = false) => {
    setRunning(true);
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

    let speedtest = await (retryAuto ? speedTest(mode) : speedTest(mode, serverId, serverUrl));

    if (mode === "ookla" && speedtest.server) {
        if (serverId === undefined) await config.updateValue("ooklaId", speedtest.server?.id);
        serverId = speedtest.server?.id;
    }

    if (mode === "libre" && speedtest.server && !serverUrl) {
        let serverEntry = Object.entries(serverController.getLibreServers())
            .filter(([, value]) => value === speedtest.server.name)[0];

        if (serverEntry) {
            if (serverId === undefined) await config.updateValue("libreId", serverEntry[0]);
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

    const release = () => {
        if (!retried) _isRunning = false;
    };

    let mode;
    try {
        mode = await config.getValue("provider");
    } catch (e) {
        release();
        throw e;
    }

    if (mode === "none") {
        release();
        return 400;
    }

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

        let {ping, jitter, download, upload, time, resultId, serverName, serverHost} = await parseData.parseData(process.env.PREVIEW_MODE === "true" ?
            "ookla" : mode, test);

        let testResult = await tests.create(ping, download, upload, time, test.serverId, type, resultId, null, jitter, serverName, serverHost);
        console.log(`Test #${testResult} was executed successfully in ${time}s. 🏓 ${ping} (±${jitter || 'N/A'}) ⬇ ${download}️ ⬆ ${upload}️`);
        createRecommendations().then(() => "");
        setRunning(false);
        sendFinished({ping, jitter, download, upload, time}).then(() => "");
    } catch (e) {
        console.log(e)
        if (!retried) return create(type, true);

        // A thrown string or a plain object has no `message`, and storing
        // undefined writes NULL - which marks the row as *successful* and lets
        // its -1 placeholder values poison every average.
        const message = toErrorMessage(e);

        let testResult = await tests.create(-1, -1, -1, null, 0, type, null, message);
        await sendError(message);
        setRunning(false, false);
        console.log(`Test #${testResult} was not executed successfully. Please try reconnecting to the internet or restarting the software: ` + message);
    }
}

export const isRunning = () => _isRunning;

export const removeOld = async () => {
    await tests.removeOld();
};
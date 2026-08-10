import os from 'node:os';
import https from 'node:https';
import * as config from '../controller/config.js';

export let interfaces = {};

export const requestInterfaces = async () => {
    let interfacesNode = os.networkInterfaces();
    let interfacesResult = {};

    console.log("Looking for network interfaces...");
    for (let i in interfacesNode) {
        for (let j in interfacesNode[i]) {
            let address = interfacesNode[i][j];

            if (address.internal) continue;

            let options = {hostname: "speed.cloudflare.com", path: "/__down?bytes=1", method: "GET",
                family: address.family === "IPv4" ? 4 : 6, timeout: 5000};

            options.agent = new https.Agent(options);
            options.localAddress = address.address;

            await new Promise((resolve) => {

                const req = https.request(options, () => {
                    if (!interfacesResult[i]) interfacesResult[i] = [];
                    interfacesResult[i].push(address.address);
                    req.destroy();
                    resolve();
                });

                req.on('error', () => resolve());
                req.on('timeout', () => req.destroy());

                req.end();
            });
        }

        if (!interfacesResult[i]) delete interfacesResult[i];
    }

    for (let i in interfacesResult) {
        for (let j in interfacesResult[i]) {
            if (interfacesResult[i][j].includes(".")) {
                interfaces[i] = interfacesResult[i][j];
                break;
            }
        }

        if (!interfaces[i]) interfaces[i] = interfacesResult[i][0];
    }

    for (let i in interfaces) {
        console.log(`Found interface ${i} with IP ${interfaces[i]}`);
    }

    const currentInterface = await config.getValue("interface");

    if (!interfaces[currentInterface]) {
        if (!currentInterface) {
            console.warn("No interface set. Falling back to default.");
        } else {
            console.warn(`Interface ${currentInterface} not found. Falling back to default.`);
        }

        // Only when there is something to fall back to: with nothing detected
        // this still claimed a fallback had happened and announced a
        // configUpdated event carrying `undefined` to every integration.
        const fallback = Object.keys(interfaces)[0];
        if (fallback === undefined) {
            console.warn("No usable network interface was found; keeping the configured one.");
            return;
        }

        await config.updateValue("interface", fallback);
    }
};
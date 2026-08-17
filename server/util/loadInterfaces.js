import os from 'node:os';
import https from 'node:https';
import * as config from '../controller/config.js';

export let interfaces = {};

/**
 * The interface map after a probing round.
 *
 * The map only ever grew. Nothing removed the key for an adapter that was no
 * longer there, so a VPN that went down stayed in GET /api/info/interfaces,
 * stayed accepted by updateValue("interface"), and - because the stale key made
 * `if (!interfaces[current])` below false - defeated the very fallback that
 * exists for this. Every scheduled test then went on binding to an address that
 * was gone, and failed, until the process restarted.
 *
 * The prune is keyed on the adapter being absent from the operating system, not
 * on this round's probe. A live interface whose Cloudflare probe happened to
 * fail is still there, and dropping it would fire the one-way fallback and
 * overwrite the operator's pinned choice for good.
 *
 * @param previous the map as it stands
 * @param probed   {name: [address]} for the adapters that answered this round
 * @param present  every adapter name the operating system reports
 */
export const resolveInterfaces = (previous, probed, present) => {
    const next = {};

    for (const name of Object.keys(previous))
        if (present.includes(name)) next[name] = previous[name];

    // This round's answer wins over the stored one. The fallback that picks an
    // address used to read the stored map, so once an adapter had an IPv4
    // address it could never be updated to an IPv6-only one - which is exactly
    // what happens when a dual-stack interface loses its v4 lease.
    for (const [name, addresses] of Object.entries(probed))
        if (addresses.length > 0)
            next[name] = addresses.find((address) => address.includes(".")) ?? addresses[0];

    return next;
};

/** What the probe asks for: the smallest response Cloudflare will send. */
const PROBE_HOST = "speed.cloudflare.com";
const PROBE_PATH = "/__down?bytes=1";

/**
 * How long an adapter gets to answer before it is taken as unusable. Named
 * rather than written into the options, so the test can assert the probe is
 * bounded at all.
 */
export const PROBE_TIMEOUT = 5000;

/**
 * Whether one address can reach the internet, tearing down what it built to ask.
 *
 * The agent is the reason this is a function rather than the body of the loop
 * below. A fresh https.Agent was built for every address on every round and
 * nothing ever destroyed one - and requestInterfaces runs on an interval for
 * the life of the process, not only at boot. Node has keep-alive on by default,
 * so each agent held its idle socket open for its own timeout and the count
 * only ever went up. Nothing broke; the process simply held more than it needed
 * to, forever.
 *
 * `request` and `Agent` are injected so this is testable without the network.
 *
 * @returns whether the address answered
 */
export const probeAddress = (address, family, {request = https.request, Agent = https.Agent} = {}) => {
    const options = {hostname: PROBE_HOST, path: PROBE_PATH, method: "GET", family, timeout: PROBE_TIMEOUT};
    const agent = new Agent(options);

    return new Promise((resolve) => {
        const req = request({...options, agent, localAddress: address}, () => {
            req.destroy();
            resolve(true);
        });

        // destroy() with no error still emits one - ECONNRESET, "socket hang
        // up" - so the timeout lands here too and the probe always settles.
        req.on('error', () => resolve(false));
        req.on('timeout', () => req.destroy());

        req.end();
    }).finally(() => agent.destroy());
};

export const requestInterfaces = async () => {
    let interfacesNode = os.networkInterfaces();
    let interfacesResult = {};

    console.log("Looking for network interfaces...");
    for (let i in interfacesNode) {
        for (let j in interfacesNode[i]) {
            let address = interfacesNode[i][j];

            if (address.internal) continue;

            const answered = await probeAddress(address.address, address.family === "IPv4" ? 4 : 6);

            if (answered) {
                if (!interfacesResult[i]) interfacesResult[i] = [];
                interfacesResult[i].push(address.address);
            }
        }

        if (!interfacesResult[i]) delete interfacesResult[i];
    }

    const resolved = resolveInterfaces(interfaces, interfacesResult, Object.keys(interfacesNode));

    // Mutated rather than reassigned: the exported binding is read through a
    // namespace import in several places, and replacing the object would leave
    // any of them that happened to hold it looking at the old map.
    for (const name of Object.keys(interfaces)) delete interfaces[name];
    Object.assign(interfaces, resolved);

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
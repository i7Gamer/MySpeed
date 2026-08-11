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
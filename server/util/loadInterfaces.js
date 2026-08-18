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

/**
 * Probes every external address an adapter reports, and keeps the ones that
 * answered.
 *
 * All at once, not one after another. Each probe is a network round trip that
 * ends on an answer or on PROBE_TIMEOUT, and they are independent by
 * construction - so awaiting them in turn cost a round the number of addresses
 * times five seconds. index.js awaits this before app.listen(), which makes that
 * time the port is not open: a Windows host carrying Hyper-V, a VPN and Docker
 * adapters that answer nothing took the better part of a minute to start
 * serving, with nothing on screen to say what it was waiting for.
 *
 * Promise.all keeps the results in the order the addresses were given, which
 * resolveInterfaces relies on when it picks one.
 *
 * `probe` is injected so this is testable without the network.
 */
export const probeAll = async (adapters, probe = probeAddress) => {
    const pending = [];

    for (const [name, addresses] of Object.entries(adapters))
        for (const address of addresses) {
            if (address.internal) continue;

            pending.push(probe(address.address, address.family === "IPv4" ? 4 : 6)
                .then((answered) => ({name, address: address.address, answered})));
        }

    const probed = {};

    for (const {name, address, answered} of await Promise.all(pending)) {
        if (!answered) continue;

        if (!probed[name]) probed[name] = [];
        probed[name].push(address);
    }

    return probed;
};

/**
 * How many consecutive rounds the configured adapter has to be missing before
 * its absence is written to the configuration.
 *
 * The write is one-way - nothing else sets this key, and the guard reads the
 * replacement as present ever after - so a single round's absence must not
 * trigger it. One round is what a tunnel being restarted looks like: WireGuard
 * removes the interface outright, so `wg-quick down` landing on the hourly
 * refresh permanently repointed every later measurement off the VPN and onto the
 * bare WAN link, showing the new choice as though the operator had made it.
 *
 * Three rounds is three hours at the refresh interval, which no restart lasts
 * and no genuinely removed adapter comes back from.
 */
export const ROUNDS_BEFORE_FALLBACK = 3;

/**
 * Whether the configured adapter's absence has lasted long enough to act on.
 *
 * Pure, so the rule can be read and tested without a database or a network.
 *
 * @param currentInterface the configured adapter, if any
 * @param available        the adapter names this round found usable
 * @param missingRounds    how many consecutive rounds it has been missing
 * @returns the new run length, and the adapter to write - or null to leave the
 *          configuration alone
 */
export const resolveFallback = (currentInterface, available, missingRounds) => {
    if (available.includes(currentInterface)) return {missingRounds: 0, write: null};

    // Nothing pinned is not a choice to protect: a fresh install picks one on
    // its first round, as it always did. It has no run of absences either -
    // there is nothing there to be absent - so the count stays at zero rather
    // than being carried into whatever is chosen next. Counted, a host that
    // spent its first rounds with no adapters at all would treat the first blink
    // after one is finally chosen as the third, and rewrite it.
    if (!currentInterface) return {missingRounds: 0, write: available[0] ?? null};

    const waited = missingRounds + 1;

    if (waited < ROUNDS_BEFORE_FALLBACK) return {missingRounds: waited, write: null};

    const fallback = available[0];

    // With nothing detected there is nothing to move to, and overwriting a good
    // setting with undefined is worse than leaving it.
    //
    // The run carries on rather than starting again. It measures how long the
    // adapter has been missing, and it has been missing on these rounds too - so
    // a host that lost every adapter and brought them back one at a time used to
    // begin the three rounds afresh from the moment there was finally something
    // to move to, leaving the measurement pointed at an adapter six rounds gone
    // instead of three.
    if (fallback === undefined) return {missingRounds: waited, write: null};

    return {missingRounds: 0, write: fallback};
};

// The run of consecutive rounds the configured adapter has been missing for.
let missingRounds = 0;

/** Forgets the run of absences. Exists so tests do not carry one between them. */
export const resetMissingRounds = () => { missingRounds = 0; };

export const requestInterfaces = async () => {
    const interfacesNode = os.networkInterfaces();

    console.log("Looking for network interfaces...");
    const interfacesResult = await probeAll(interfacesNode);

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

    const decision = resolveFallback(currentInterface, Object.keys(interfaces), missingRounds);
    missingRounds = decision.missingRounds;

    if (decision.write === null) {
        if (!interfaces[currentInterface] && currentInterface)
            // Two different states, and the count tells them apart: still inside
            // the wait, or past it with nothing usable to move to. One reads as
            // progress towards a decision, the other as a decision that cannot
            // be made - and printing the first as "(4/3)" describes neither.
            console.warn(missingRounds >= ROUNDS_BEFORE_FALLBACK
                ? `Interface ${currentInterface} has been missing for ${missingRounds} rounds and `
                    + `nothing usable was found to move to. Keeping it.`
                : `Interface ${currentInterface} was not found this round ` +
                    `(${missingRounds}/${ROUNDS_BEFORE_FALLBACK}). Keeping it for now.`);
        else if (!currentInterface)
            console.warn("No usable network interface was found; keeping the configured one.");

        return;
    }

    // The old value is named, because this is the one place the operator's own
    // choice is overwritten by the server and nothing records what it was.
    console.warn(currentInterface
        ? `Interface ${currentInterface} has been missing for ${ROUNDS_BEFORE_FALLBACK} rounds. ` +
          `Falling back to ${decision.write}.`
        : `No interface set. Falling back to ${decision.write}.`);

    await config.updateValue("interface", decision.write);
};
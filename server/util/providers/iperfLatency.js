import net from 'node:net';

/**
 * The latency figures for an iperf3 target, which iperf3 itself does not
 * measure.
 *
 * Every other provider reports a ping because it is talking to a speedtest
 * backend that answers one; iperf3 is a throughput tool and its JSON carries no
 * latency of any kind. The columns are not optional - the overview grades a
 * ping on every row and the detail pane draws it - so the alternative to
 * measuring one here is storing the failure placeholder on a run that
 * succeeded, which reads as a broken line.
 *
 * The round trip of a TCP handshake, rather than ICMP: an echo request needs a
 * raw socket, which needs privileges the server deliberately gave up in 1.3.5,
 * and it would measure a different path from the one being tested anyway. The
 * handshake goes to the very host and port the transfer will use, over the same
 * interface, so what it times is the connection the test is about - and it is
 * one round trip by construction, since the timer stops when the peer's SYN-ACK
 * arrives.
 *
 * What it is not is comparable to the other providers' figures to the
 * millisecond: theirs are application-level round trips to a server chosen to
 * be near, and a handshake includes the accept queue at the far end. Against
 * the same target over time - which is what a target is for - it is a
 * consistent measure of the same thing.
 */

/**
 * How many handshakes one reading is made of.
 *
 * Enough that a single outlier cannot be the answer - the median of five
 * survives two - and few enough that the whole sample costs well under a second
 * on any line worth measuring. They are taken one after another rather than at
 * once: five simultaneous connections measure the far end's ability to accept
 * five connections, which is not the question.
 */
export const LATENCY_SAMPLES = 5;

/**
 * How long one handshake may take before it is abandoned.
 *
 * A sample that times out is dropped rather than recorded as this figure -
 * recording it would put a made-up two thousand milliseconds into an average.
 * The transfer that follows has its own, much longer, deadline; this only
 * bounds the measurement.
 */
export const LATENCY_TIMEOUT_MS = 2000;

const MS_PER_SECOND = 1000;
const NS_PER_MS = 1e6;

const round = (value) => value === null ? null : parseFloat(value.toFixed(2));

/** The middle value, or the mean of the two middle ones. */
export const median = (values) => {
    if (!Array.isArray(values) || values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * How much the samples wander, as the mean distance from their own median.
 *
 * The same quantity the other providers call jitter, worked out the way a set
 * of independent samples allows. Ookla's is the variation between consecutive
 * packets in one stream; there is no stream here, only five separate
 * handshakes, so the spread of the set is what can honestly be said about how
 * steady the path is.
 *
 * Around the median rather than the mean, so one slow handshake widens the
 * figure without also dragging the centre it is measured from.
 */
export const spread = (values) => {
    if (!Array.isArray(values) || values.length < 2) return null;

    const centre = median(values);

    return values.reduce((total, value) => total + Math.abs(value - centre), 0) / values.length;
};

/**
 * One handshake, timed, or null if it did not complete.
 *
 * Null rather than a throw: a target that refuses one connection and accepts
 * the next is a real thing, and the sample that failed is simply not a
 * measurement. The socket is destroyed as soon as the connection is up - the
 * handshake is the whole measurement, and iperf3 opens its own connections.
 */
export const sampleHandshake = ({host, port, localAddress, timeoutMs = LATENCY_TIMEOUT_MS,
    connect = net.connect} = {}) => new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;

    const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
    };

    // localAddress binds the measurement to the interface the transfer will
    // use, the way every provider's arguments do - without it a machine with
    // more than one route can time a path the test never touches.
    //
    // The family travels with it, because the bind pins it anyway: left open,
    // the resolver may pick the other family for a dual-stack hostname, and a
    // bind of an IPv4 address onto an IPv6 connection is refused outright
    // (`bind EINVAL`) - so a dual-stack endpoint measured over a pinned IPv4
    // interface dropped every sample and stored 0 ms for the life of the
    // target. Unpinned, the resolver stays free.
    const socket = connect({host, port, ...(localAddress
        ? {localAddress, family: net.isIP(localAddress) === 6 ? 6 : 4}
        : {})});

    socket.setTimeout?.(timeoutMs, () => {
        socket.destroy();
        done(null);
    });

    socket.once("connect", () => {
        const elapsed = Number(process.hrtime.bigint() - started) / NS_PER_MS;
        socket.destroy();
        done(elapsed);
    });

    // on(), not once(): the first error settles the sample, and a second one
    // - a reset during the teardown this handler starts - must find a
    // listener too. An error nobody hears is thrown, and thrown from here
    // reaches the process-level hook, which exits. done() is idempotent.
    socket.on("error", () => {
        socket.destroy();
        done(null);
    });
});

/**
 * The ping and jitter for one target, from a handful of handshakes.
 *
 * Both null when every sample failed - which is not the same as a latency of
 * zero, and the caller decides what to do about it. A run whose transfer
 * succeeded is still a result: the throughput was measured, and only the
 * latency was not.
 */
export const measureLatency = async ({host, port, localAddress, samples = LATENCY_SAMPLES,
    timeoutMs = LATENCY_TIMEOUT_MS, connect = net.connect} = {}) => {

    const readings = [];

    for (let attempt = 0; attempt < samples; attempt++) {
        const reading = await sampleHandshake({host, port, localAddress, timeoutMs, connect});
        if (reading !== null) readings.push(reading);
    }

    if (readings.length === 0) return {ping: null, jitter: null};

    return {ping: round(median(readings)), jitter: round(spread(readings))};
};

export const LATENCY_BUDGET_MS = LATENCY_SAMPLES * LATENCY_TIMEOUT_MS;

/** Seconds, for the callers that reason about how long a whole test may take. */
export const latencyBudgetSeconds = () => LATENCY_BUDGET_MS / MS_PER_SECOND;

/**
 * Whether there is still somebody waiting for this response.
 *
 * For work that is queued rather than run on arrival, where the wait can outlast
 * the caller. The prometheus scrape is the case this was written for: scrapes
 * are serialised so that two of them cannot clear each other's gauges, and
 * Prometheus gives up on one at its scrape_timeout - ten seconds by default -
 * so a queued entry can reach the front with nothing at the other end. Reading
 * the latest test and rendering the whole registry for a socket nobody is
 * listening to is work that cannot arrive anywhere.
 *
 * Both ends are asked because they mean different things. `req.destroyed` is
 * the client hanging up mid-request; `res.writableEnded` is a response that was
 * already answered, which is what a double dispatch looks like from inside a
 * queue. Coerced to a boolean so a caller can compare it rather than having to
 * remember that a missing property reads as undefined.
 */
export const clientGone = (req, res) =>
    Boolean(req?.destroyed || res?.destroyed || res?.writableEnded);

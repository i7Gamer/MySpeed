import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientGone } from "../../server/util/clientGone.js";

/**
 * Whether there is still anybody to answer.
 *
 * Written for the prometheus scrape, which is queued so that two of them cannot
 * clear each other's gauges. Queueing means waiting, and a caller that has
 * given up while it waited is one this instance should not spend a database
 * read and a full render on: Prometheus drops a scrape at its scrape_timeout,
 * ten seconds by default, and then nothing is reading the socket the answer is
 * written to.
 *
 * Both halves are checked because they say different things. `req.destroyed` is
 * the client hanging up mid-request; `res.writableEnded` is a response that has
 * already been answered, which is what a retry or a double-dispatch would look
 * like from inside the queue.
 */
describe("clientGone", () => {
    const live = () => ({destroyed: false, writableEnded: false});

    it("says no while both ends are still open", () => {
        assert.equal(clientGone(live(), live()), false);
    });

    it("notices a client that hung up", () => {
        assert.equal(clientGone({destroyed: true}, live()), true);
    });

    it("notices a response socket that has gone", () => {
        assert.equal(clientGone(live(), {destroyed: true}), true);
    });

    it("notices a response that has already been sent", () => {
        assert.equal(clientGone(live(), {destroyed: false, writableEnded: true}), true);
    });

    // Answers a boolean rather than whatever it read, so a caller can use it in
    // a comparison without the undefined a bare property access would give.
    it("answers a boolean, never undefined", () => {
        assert.equal(clientGone({}, {}), false);
        assert.equal(clientGone(undefined, undefined), false);
    });
});

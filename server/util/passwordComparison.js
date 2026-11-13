import bcrypt from 'bcryptjs';
import { createQueue } from './serialiseQueue.js';

/**
 * Password comparisons, one at a time.
 *
 * bcryptjs is JavaScript on the only thread, and its asynchronous form does not
 * change what that costs - it defers the work to setImmediate. Every immediate
 * queued by the time the loop reaches that phase runs before the loop reads a
 * socket again, so N comparisons started together block for N comparisons in
 * one piece: /api/health, the dashboard and every signed-in caller wait behind
 * guesses made by somebody else.
 *
 * Run one after another, the same work gives the loop a turn between each. The
 * total is unchanged - there was never a second core to run them on - so
 * nothing is slower for it; what changes is that the rest of the server gets
 * served in the gaps. How many may wait here at all is reserveAttempt's
 * business, in middlewares/password.js.
 *
 * The comparison is a parameter so a test can count overlaps without paying
 * for a hash.
 */
export const createPasswordComparer = (compare = (candidate, hash) => bcrypt.compare(candidate, hash)) => {
    const queue = createQueue();

    return (candidate, hash) => queue(() => compare(candidate, hash));
};

/** The one queue every entry point shares - three queues would be three lanes. */
export const comparePassword = createPasswordComparer();

import { causesOf, damageFrom } from './databaseIntegrity.js';

/**
 * Whether a database error says the database itself has gone, rather than that
 * one row was refused.
 *
 * Asked in the middle of a speedtest round, by the guard that stops one member's
 * failure from ending it. The two cases have to be told apart because they want
 * opposite things:
 *
 *  - A refusal about the row is the next member's problem only if it shares the
 *    row's problem. models/Speedtests.js records one that nothing else shared:
 *    MySQL in strict mode refusing a stderr longer than the column it was going
 *    into, thrown from inside the very handler that records failed tests. The
 *    members after it had shorter messages and recorded perfectly well, so
 *    ending the round there would have thrown away measurements that nothing
 *    was wrong with.
 *  - A database that has gone takes every later write with it. Carrying on then
 *    costs each remaining member thirty to sixty seconds of CLI time measuring a
 *    line whose result has nowhere to go, and answers with one more failure that
 *    cannot be recorded either.
 *
 * Read through the wrapper with databaseIntegrity's own walk rather than a
 * second copy of it - which property sequelize hands the driver's error on has
 * moved between versions, and one of two walks is always the one nobody updated.
 */

/**
 * Sequelize's own names for a connection that could not be made or was lost.
 *
 * Matched by name rather than with `instanceof ConnectionError`, which would
 * pull the ORM into a module that is otherwise pure - and would answer false
 * anyway if a second copy of sequelize ever landed in the tree. The driver's
 * error underneath is read as well, so a name missing from this list still lands
 * by its code.
 */
const OUTAGE_NAMES = new Set([
    "SequelizeConnectionError",
    "SequelizeConnectionRefusedError",
    "SequelizeConnectionTimedOutError",
    "SequelizeConnectionAcquireTimeoutError",
    "SequelizeAccessDeniedError",
    "SequelizeHostNotFoundError",
    "SequelizeHostNotReachableError",
    "SequelizeInvalidConnectionError"
]);

/**
 * The driver codes that say the same thing. mysql2's are the connection ones -
 * a server restarted underneath us, an idle connection reaped by wait_timeout,
 * a socket dropped mid-round - and bun:sqlite reports sqlite's own names as
 * strings. node:sqlite does not; see OUTAGE_RESULT_CODES below.
 *
 * SQLITE_BUSY is deliberately absent. A lock held by another writer is
 * contention, not absence: the shim already waits BUSY_TIMEOUT_MS for it, and
 * the next member is a whole CLI run away, by which time the transaction
 * holding it has long committed. If it is not transient after all, the second
 * member in a row that cannot record ends the round anyway -
 * MAX_CONSECUTIVE_ESCAPES in tasks/speedtest.js is what covers every way the
 * database can go that these lists cannot name.
 */
const OUTAGE_CODES = new Set([
    "PROTOCOL_CONNECTION_LOST",
    "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "SQLITE_CANTOPEN",
    "SQLITE_FULL",
    "SQLITE_IOERR",
    "SQLITE_READONLY"
]);

/**
 * sqlite's own result codes, which under node:sqlite are the only thing that
 * names the fault at all: every error it throws carries `code:
 * "ERR_SQLITE_ERROR"` and puts the real code in a numeric `errcode`. Measured
 * rather than assumed - a database in a directory that does not exist answers 14
 * with the message "unable to open database file", and an ordinary SQL mistake
 * answers 1, which is why the whole set is not simply "threw".
 */
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;

const OUTAGE_RESULT_CODES = new Set([SQLITE_READONLY, SQLITE_IOERR, SQLITE_FULL, SQLITE_CANTOPEN]);

/**
 * sqlite refines most of those with an extended code in the higher bytes -
 * SQLITE_IOERR_WRITE is 778, and only its low byte is SQLITE_IOERR - so it is
 * the primary code that the set above is asked about.
 */
const SQLITE_PRIMARY_CODE_MASK = 0xFF;

/**
 * And the wording, for the failures that carry no code worth matching, the way
 * damageFrom keeps a wording of its own.
 *
 * node:sqlite reports a handle closed underneath a query as ERR_INVALID_STATE -
 * a code general enough that matching on it would classify errors having nothing
 * to do with the database - and sequelize throws a plain Error once its
 * connection manager has been shut down, with nothing on it but the sentence.
 */
const OUTAGE_WORDING =
    /database is not open|connection manager was closed|connection (?:lost|closed|was closed)|unable to open database file|disk i\/o error|database or disk is full|attempt to write a readonly database/i;

const saysOutage = (candidate) => OUTAGE_NAMES.has(candidate.name)
    || OUTAGE_CODES.has(candidate.code)
    || (typeof candidate.errcode === "number"
        && OUTAGE_RESULT_CODES.has(candidate.errcode & SQLITE_PRIMARY_CODE_MASK))
    || (typeof candidate.message === "string" && OUTAGE_WORDING.test(candidate.message));

export const outageFrom = (error) => {
    try {
        // A file sqlite calls unreadable is an outage for anything trying to
        // write to it, so damage counts here too. The boot check keeps its own
        // name for that case because it can offer a recovery procedure; a round
        // in flight has nothing to offer but stopping.
        return causesOf(error).some(saysOutage) || damageFrom(error);
    } catch {
        // This is called from the handler that keeps a broken member from ending
        // the round, so a throw in here would cause the exact failure the caller
        // exists to prevent. A property that throws when it is read - a getter on
        // a hostile object, a revoked proxy - costs the classification and
        // nothing else: the count of members in a row that could not record
        // still ends the round if the database really has gone.
        return false;
    }
};

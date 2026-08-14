import config from '../models/Config.js';
import { NO_PASSWORD } from '../controller/config.js';

/**
 * The way back into an instance whose password is no longer known.
 *
 * There is no other one. The setup token and loopback access both only apply
 * while the stored value is the unconfigured sentinel, so on an instance that
 * *has* a password every route in is refused by the very credential that was
 * lost - including the one that would change it, and the one that would restore
 * a backup. Until this existed the only remedy was editing the config table by
 * hand, which is not a thing to ask of someone reading a log at midnight.
 *
 * It is a flag on the entry point rather than a script beside it so that each
 * deployment can reach it with whatever it already has, which is not the same
 * thing in both. Windows installs a compiled binary and no runtime, so there it
 * is `MySpeed --reset-password`. The image is the other way round - it ships the
 * bun runtime and the server sources, and never builds a binary at all - so
 * there it is `docker exec <container> bun server/index.js --reset-password`,
 * against the same entry point the image's own CMD runs.
 */
export const RESET_PASSWORD_FLAG = "--reset-password";

/**
 * Exactly the flag, never an approximation of it.
 *
 * Starting the server is the default and by far the common case, so an argument
 * that merely looks like this one has to fall through to it. Guessing at a typo
 * here would clear the password of an instance someone meant to start.
 */
export const wantsPasswordReset = (argv = process.argv) => argv.includes(RESET_PASSWORD_FLAG);

export const RESET_CLEARED = "cleared";
export const RESET_ALREADY_CLEAR = "already-clear";
export const RESET_NO_CONFIG = "no-config";

/**
 * Whether a query failed because there is no configuration table to read.
 *
 * The likeliest mistake with this command is running the binary from the wrong
 * directory: the database resolves `data/storage.db` relative to it, and sqlite
 * creates an empty file rather than refusing, so the first query dies on a
 * table that was never there. That is worth its own sentence, not a raw
 * "SQLITE_ERROR: no such table: config".
 *
 * Matched on what the dialects say rather than on a driver code, because the
 * two supported ones word it differently and neither code reaches here
 * unwrapped. Narrow on purpose: a corrupt or locked database has to keep
 * travelling, since answering it with "there is no configuration here" would
 * send someone whose data is in trouble off to check their path.
 */
export const isMissingConfigTable = (error) =>
    error?.name === "SequelizeDatabaseError"
    && /no such table|doesn't exist|does not exist/i.test(error?.message ?? "");

/**
 * Clears the password, and says what it found.
 *
 * Clearing rather than setting a new one: a password given on the command line
 * is left in the shell history and stands in the process list of a machine that
 * may not be the operator's alone. Cleared, the instance falls back to the
 * setup-token flow that exists for precisely this situation - open on its own
 * loopback, refusing the network until the token from its log is presented -
 * and the operator sets a real password from the interface, where the policy
 * and the confirmation box apply.
 *
 * Written through the model rather than through updateValue, which does two
 * things besides the write and neither of them survives the process boundary:
 *
 * It fires the `configUpdated` integration event, and a recovery command must
 * not be able to hang on an unreachable webhook - it would also be firing from
 * a second process that no integration belongs to.
 *
 * And it calls destroyAllSessions, which is a real guarantee where it is made:
 * a password change inside the server takes access back, and a session left
 * alive would undo that. Here it would guarantee nothing. Sessions are an
 * in-memory Map per process, so this command would clear its own - empty, it
 * has never issued one - while every session the running server holds carries
 * on untouched. Calling it anyway would only read as though the sessions had
 * been dealt with. They have not: they stay valid until they expire or the
 * server is restarted, which is what the README tells the operator to do, and
 * is the honest version of it.
 *
 * The outcome is returned rather than printed so this can be tested against a
 * real table; index.js owns the exit code, and the wording below it.
 */
export const resetPassword = async () => {
    let stored;

    try {
        stored = await config.findOne({where: {key: "password"}});
    } catch (error) {
        if (isMissingConfigTable(error)) return RESET_NO_CONFIG;
        throw error;
    }

    // No row at all means the table was never seeded - an instance that has not
    // finished its first start, or a database this was pointed at by mistake.
    // Seeding it here would answer a lockout by inventing the configuration it
    // was supposed to be recovering.
    if (stored === null) return RESET_NO_CONFIG;

    // Said, not silently reported as a success: an operator who is still locked
    // out after being told the password was cleared will go looking anywhere
    // but here for the reason.
    if (stored.value === NO_PASSWORD) return RESET_ALREADY_CLEAR;

    await config.update({value: NO_PASSWORD}, {where: {key: "password"}});

    return RESET_CLEARED;
};

/**
 * Where to look when the database held no configuration to reset.
 *
 * This is the whole content of the nothing-to-do exit: the code says the data is
 * somewhere other than where the command looked, and this line is what says
 * where to go. Pointed at the wrong thing it is worse than saying nothing, since
 * it is specific enough to be believed and spent on.
 *
 * Which means it cannot be the same line for both backends. A file database is
 * chosen by the working directory, so that is what to check. A MySQL connection
 * is named entirely by environment variables and has no data directory at all -
 * sending that operator to inspect a path costs them the one thing this exit
 * code was for. The start-up handler in index.js already splits on the same
 * variable for the same reason.
 */
export const noConfigReport = (env = process.env) => [
    "This database holds no MySpeed configuration, so there is no password to reset.",
    env.DB_TYPE === "mysql"
        ? "Check that DB_NAME, DB_HOST and DB_USER name the database the server actually runs against."
        : "Check that the data directory is the one the server actually runs against."
];

/**
 * What the command says once it has finished, which is all the operator gets.
 *
 * It exits immediately afterwards, so these lines are not a summary of a state
 * that can then be inspected - as far as someone reading them at midnight is
 * concerned, they are the state.
 *
 * Built as values rather than printed from inside the handler so the branch
 * below can be exercised directly. Scanning index.js for it instead would mean
 * asserting on the shape of a source file, because importing that file starts a
 * server.
 */
export const clearedReport = (outcome, env = process.env) => {
    const lines = [
        "",
        outcome === RESET_ALREADY_CLEAR
            ? "  This instance already had no password set."
            : "  The password has been removed.",
        ""
    ];

    /**
     * ALLOW_NO_PASSWORD is only ever consulted while the stored value is the
     * unconfigured sentinel - which is precisely what this command restores. So
     * a variable that has been a no-op for as long as a password was set comes
     * back to life at the moment the password goes, and the instance this
     * returns is not the guarded one the other branch describes: it is reachable
     * by anyone who can route to it, with no credential and no token. Telling
     * that operator their instance now asks other machines for a setup token
     * would be the exact opposite of what happened.
     *
     * The boot-time warning that covers this state never runs here, because the
     * reset returns before the server is started.
     *
     * Read from this process's environment, which is the same one the server
     * sees under Docker but need not be on Windows, where a service carries its
     * own. It can therefore miss a variable set only for the service - it cannot
     * invent one - so the quiet branch stays the honest default.
     */
    if (env.ALLOW_NO_PASSWORD === "true")
        lines.push(
            "  WARNING: ALLOW_NO_PASSWORD is set for this process, and it applies again as",
            "  soon as the password is gone. Anyone who can reach this instance now has full",
            "  control of it, with no credential and no token. Set a new password from the",
            "  settings menu, or unset the variable and restart the server.",
            ""
        );
    else
        lines.push(
            "  The instance is now open to the machine it runs on, and asks every other",
            "  machine for a setup token. Open the interface: the server prints that token",
            "  to its log as it turns the request away. Then set a new password from the",
            "  settings menu - no restart is needed.",
            ""
        );

    return lines;
};

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
 * It is a flag on the server binary rather than a script beside it because both
 * supported deployments ship one compiled binary and no runtime to run a script
 * with: `MySpeed --reset-password` on Windows, `docker exec <container>
 * ./MySpeed --reset-password` under Docker.
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
 * Written through the model rather than through updateValue: that fires the
 * `configUpdated` integration event, and a recovery command must not be able to
 * hang on an unreachable webhook. It would also be firing from a second process
 * that no integration belongs to.
 *
 * The outcome is returned rather than printed so this can be tested against a
 * real table; index.js owns the wording and the exit code.
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

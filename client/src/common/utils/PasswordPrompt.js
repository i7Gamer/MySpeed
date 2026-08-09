/**
 * Asks for the password until it is accepted or the user gives up.
 *
 * The two places that ask - the header's admin login and the dialog the page
 * opens when it loads unauthenticated - disagreed about what a rejected
 * password means. The header asked again; the other called login(), discarded
 * the false it answered with and stopped, leaving a blank dashboard with
 * nothing said. Sharing the loop is what keeps them from drifting apart again.
 *
 * `prompt` is handed the refusal that ended the previous attempt - null on the
 * first ask - so it can say what went wrong and, when the reason calls for it,
 * ask something else entirely. It returns the value entered, or something falsy
 * when dismissed. Dismissing is a decision rather than a failure: an empty box
 * never reaches `authenticate`, which would otherwise spend a bcrypt comparison
 * and count against the password throttle for a value nobody typed.
 *
 * @param {(previous: {type?: string}|null) => Promise<string|undefined>} prompt
 * @param {(value: string) => Promise<{ok: boolean, type?: string}>} authenticate
 * @returns {Promise<boolean>} whether the caller is now authenticated
 */
export const promptUntilAccepted = async (prompt, authenticate) => {
    let previous = null;

    for (;;) {
        const value = await prompt(previous);

        if (!value) return false;

        const outcome = await authenticate(value);
        if (outcome.ok) return true;

        previous = outcome;
    }
};

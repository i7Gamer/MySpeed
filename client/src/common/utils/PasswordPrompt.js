/**
 * Asks for the password until it is accepted or the user gives up.
 *
 * The two places that ask - the header's admin login and the dialog the page
 * opens when it loads unauthenticated - disagreed about what a rejected
 * password means. The header asked again; the other called login(), discarded
 * the false it answered with and stopped, leaving a blank dashboard with
 * nothing said. Sharing the loop is what keeps them from drifting apart again.
 *
 * `prompt` is told whether the previous attempt was rejected, so it can say so,
 * and returns the value entered or something falsy when dismissed. Dismissing
 * is a decision rather than a failure: an empty box never reaches
 * `authenticate`, which would otherwise spend a bcrypt comparison and count
 * against the password throttle for a value nobody typed.
 *
 * @param {(failed: boolean) => Promise<string|undefined>} prompt
 * @param {(value: string) => Promise<boolean>} authenticate
 * @returns {Promise<boolean>} whether the caller is now authenticated
 */
export const promptUntilAccepted = async (prompt, authenticate) => {
    for (let failed = false; ; failed = true) {
        const value = await prompt(failed);

        if (!value) return false;
        if (await authenticate(value)) return true;
    }
};

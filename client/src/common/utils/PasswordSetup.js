/**
 * A note left for the page that comes back after a setup-token sign-in.
 *
 * The token gets the operator in; it does not give the instance a password.
 * Without this the reload drops them on a working dashboard with the job half
 * done - and the next restart issues a different token, so the same lockout
 * returns with a new credential to hunt for. The note asks the settings dialog
 * to open itself once, so the way in leads to the way out.
 *
 * Session storage rather than local: it belongs to the sign-in that just
 * happened, not to the browser forever.
 */
const PASSWORD_UNSET_KEY = "setPasswordAfterSetupToken";

export const markPasswordUnset = (storage = sessionStorage) =>
    storage.setItem(PASSWORD_UNSET_KEY, "true");

/**
 * Reads the note and removes it, so it acts once.
 *
 * Taken rather than read: left in place it would reopen the dialog on every
 * reload, including the one that follows setting the password.
 */
export const takePasswordUnsetMark = (storage = sessionStorage) => {
    const marked = storage.getItem(PASSWORD_UNSET_KEY) === "true";

    if (marked) storage.removeItem(PASSWORD_UNSET_KEY);

    return marked;
};

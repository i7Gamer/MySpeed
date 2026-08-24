import {readSession, writeSession, removeSession} from "@/common/utils/Storage";

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

/**
 * Reached through Storage.js rather than as a bare `sessionStorage`.
 *
 * The property access is what throws: a browser blocking site data answers a
 * SecurityError rather than null, and Chrome and Edge do it for any
 * cross-origin iframe with third-party cookies off - which is Incognito by
 * default, and which is where this dashboard is meant to sit, since
 * FRAME_ANCESTORS exists so it can be embedded in Homepage or Heimdall.
 *
 * Both of these are called with no argument from a mount effect in
 * DropdownComponent, so that throw came out of a React effect on the header of
 * an instance that works perfectly well, and the error boundary replaced the
 * whole app. Storage.js already answers this for localStorage and now answers it
 * for both; the note is on the same footing as a preference, and a blocked store
 * costs it only surviving the reload.
 *
 * Still an injectable parameter, because what a caller passes is the store this
 * acts on - the default is simply one that cannot throw.
 */
const safeSession = {
    getItem: readSession,
    setItem: writeSession,
    removeItem: removeSession
};

export const markPasswordUnset = (storage = safeSession) =>
    storage.setItem(PASSWORD_UNSET_KEY, "true");

/**
 * Reads the note and removes it, so it acts once.
 *
 * Taken rather than read: left in place it would reopen the dialog on every
 * reload, including the one that follows setting the password.
 */
export const takePasswordUnsetMark = (storage = safeSession) => {
    const marked = storage.getItem(PASSWORD_UNSET_KEY) === "true";

    if (marked) storage.removeItem(PASSWORD_UNSET_KEY);

    return marked;
};

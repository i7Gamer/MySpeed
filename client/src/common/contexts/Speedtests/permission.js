/**
 * Whether the rows in hand were fetched under a permission that no longer
 * holds, and the permission to hold from here.
 *
 * A read-only session is served speedtests with stripConnectionIdentity run
 * over every row - isp and externalIp nulled, resultId deleted - and the detail
 * pane gates its Connection fact and its result link on exactly those, so under
 * that session they render nothing. Signing in through the header is the one
 * login path that does not reload the page: it exchanges the password for a
 * session and reloads the config, and the list is keyed on neither. Without
 * this the rows stayed as the read-only fetch left them and a full page reload
 * was the only way back.
 *
 * A transition rather than the value, because the list and the config are
 * fetched side by side at mount: the first answer is the baseline, not a
 * change, and reading it as one would refetch the whole list on every load.
 *
 * The held value is returned rather than written from whatever arrives, so an
 * answer carrying no permission leaves the baseline alone. Recording the
 * absence would make the next real answer look like a first one, and the
 * refetch it needs would be skipped with nothing said.
 */
export const reloadOnPermissionChange = (held, viewMode, reload) => {
    if (viewMode === undefined) return held;

    if (held !== undefined && held !== viewMode) reload();

    return viewMode;
};

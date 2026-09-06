/**
 * The name a node may be given.
 *
 * nodes.name is a plain STRING column - VARCHAR(255) on MySQL - and the two
 * routes that write it checked only that something was sent. A longer name
 * passed them and MySQL refused the row with ER_DATA_TOO_LONG, which Express
 * answered as its generic 500 where a 400 naming the limit was owed; sqlite
 * stored it whole, so the fault was invisible on the dialect the suite runs.
 *
 * The limit is the column's, and this is its one home: both routes and the
 * config import ask here. Blankness is not judged here - the routes refuse an
 * empty name before they ask, and a backup is not refused over a name the
 * instance that wrote it was carrying.
 */
export const NODE_NAME_LIMIT = 255;

export const nodeNameProblem = (name) => {
    if (typeof name !== "string") return "A node's name must be a string";
    if (name.length > NODE_NAME_LIMIT) return `A node's name must be ${NODE_NAME_LIMIT} characters or fewer`;

    return null;
};

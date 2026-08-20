/**
 * The size policy of a backup, in one place for its two consumers.
 *
 * routes/storage.js takes the import limit for its body parser; the node
 * proxy in controller/node.js takes the same figure as the relay allowance
 * for the backup exports. This used to live in the routes module, which made
 * the proxy the one controller in the codebase importing route wiring - a
 * layering inversion a refactor of the route file would trip over. It sits
 * in util beside safeRequest.js, whose default ceiling is the very thing the
 * allowance raises.
 */

// A restore legitimately carries years of history, so the import endpoints
// are the only ones allowed a large body - and only once the caller has
// authenticated. One figure spelled twice, from one number: express takes the
// suffixed string, the proxy takes the bytes.
const IMPORT_BODY_LIMIT_MB = 50;

export const IMPORT_BODY_LIMIT_BYTES = IMPORT_BODY_LIMIT_MB * 1024 * 1024;

export const IMPORT_BODY_LIMIT = `${IMPORT_BODY_LIMIT_MB}mb`;

export const LARGE_BODY_PATHS = ["/api/storage/tests/history", "/api/storage/config"];

/**
 * The reads that answer with a whole backup, which is the import's size in the
 * other direction. The node proxy holds every relayed answer to a ceiling, and
 * these are the endpoints legitimately above its default: a node with a year of
 * history exports more than ten megabytes by being used, not by being hostile.
 * They get the import limit as their allowance, because the two are one round
 * trip - an export too large to ever restore is not a backup.
 */
export const BACKUP_EXPORT_PATHS =
    ["/api/storage/tests/history/json", "/api/storage/tests/history/csv", "/api/storage/config"];

/**
 * What the relay grants a backup export, held on an object so a test can
 * shrink the allowance instead of flooding fifty real megabytes through a
 * socket to reach it. Production reads it and never writes it.
 */
export const relayPolicy = {backupAllowanceBytes: IMPORT_BODY_LIMIT_BYTES};

// While a node is selected the client sends the imports through the proxy
// prefix, so the parent sees /api/nodes/<id>/storage/... An exact-string list
// missed that entirely: the 100kb parser ran instead and every import of a
// real history - the case the large limit exists for - failed with 413.
const NODE_PREFIX = /^\/api\/nodes\/[^/]+/;

// The query is stripped because the proxy asks with req.originalUrl, which
// keeps it - req.path is rewritten relative to the router's mount by the time
// the proxy handler runs, so it no longer names these paths at all.
const asParentPath = (path) => {
    const bare = path.split("?")[0];
    const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;

    return trimmed.replace(NODE_PREFIX, "/api");
};

export const isLargeBodyPath = (path) => LARGE_BODY_PATHS.includes(asParentPath(path));

export const isBackupExportPath = (path) => BACKUP_EXPORT_PATHS.includes(asParentPath(path));

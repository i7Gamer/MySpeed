import crypto from 'node:crypto';
import apiTokens from '../models/ApiTokens.js';
import { SCOPE_RUN, SCOPES } from '../util/tokenScopes.js';

export { SCOPE_RUN, SCOPES };

/**
 * API tokens: a credential the operator issues for one purpose - starting a
 * test from a script, a router hook or a home-automation platform - so that
 * nothing outside the browser ever holds the admin password.
 *
 * The secret is `msp_` and 32 random bytes as base64url, shown once when it
 * is issued and never stored: the row keeps its sha256 digest, and a request
 * is judged by looking the digest of what it carried up in the table. No
 * bcrypt, on purpose. Password hashing is slow so that a *guessable* secret
 * cannot be brute-forced offline; a token with 256 bits of entropy is not
 * guessable at any speed, and a slow hash would only put bcrypt's cost on the
 * event loop for every automation poll.
 */

/** Marks a token as MySpeed's, so a leaked one is recognisable in a log or a paste. */
export const TOKEN_PREFIX = "msp_";

/** 256 bits: past guessing at any rate a network allows. */
export const TOKEN_BYTES = 32;

/** The longest name a token may carry - a label in a list, not a description. */
export const TOKEN_NAME_LIMIT = 64;

/**
 * The most tokens one instance may hold. Far above any honest use - one per
 * automation - and a ceiling on what the list route answers and the backup
 * restores.
 */
export const MAX_TOKENS = 50;

/**
 * How often a token's last-used moment is written. A courtesy to the
 * operator reading the list, not a ledger: an automation polling the live
 * status twice a second must not cost a database write per poll.
 */
export const LAST_USED_GRANULARITY_MS = 60 * 1000;

export const generateToken = () => TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("base64url");

export const digestOf = (secret) => crypto.createHash("sha256").update(secret).digest("hex");

/**
 * The MySpeed token on an Authorization header, or null.
 *
 * Only a token with the prefix is read. A forward-auth proxy - oauth2-proxy,
 * Authelia, Authentik - puts `Authorization: Bearer <JWT>` on every request it
 * forwards, and the browser behind it must keep reaching the password gate
 * rather than being refused for a token it never sent. Basic credentials go
 * to the prometheus route, which reads the same header.
 */
const BEARER = /^bearer\s+(\S+)\s*$/i;

export const parseBearer = (header) => {
    if (typeof header !== "string") return null;

    const match = BEARER.exec(header);
    if (match === null || !match[1].startsWith(TOKEN_PREFIX)) return null;

    return match[1];
};

/** What is wrong with a name a token would be given, or null. */
export const tokenNameProblem = (name) => {
    if (typeof name !== "string" || name.trim() === "") return "A token needs a name";
    if (name.trim().length > TOKEN_NAME_LIMIT) return `A token's name must be ${TOKEN_NAME_LIMIT} characters or fewer`;
    // The name is printed into the log when the token starts a run, and a
    // name carrying a line break forges a log line; a node password is
    // refused the same characters for a smaller blast radius.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(name)) return "A token's name must not contain a control character";

    return null;
};

const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

const isMoment = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * A backup's row as the table would write it, or null for one the table could
 * not have produced. The file's id is dropped: ids are the writing instance's.
 */
export const importableToken = (row) => {
    if (row === null || typeof row !== "object") return null;
    if (tokenNameProblem(row.name) !== null) return null;
    if (typeof row.digest !== "string" || !DIGEST_SHAPE.test(row.digest)) return null;
    if (!SCOPES.includes(row.scope)) return null;
    if (row.created !== undefined && !isMoment(row.created)) return null;
    if (row.lastUsed != null && !isMoment(row.lastUsed)) return null;

    return {
        name: row.name.trim(),
        digest: row.digest,
        scope: row.scope,
        created: row.created ?? new Date().toISOString(),
        lastUsed: row.lastUsed ?? null
    };
};

// When each token's last use was last written, by id.
const touched = new Map();

/** Clears the last-used memory. Exists for the tests. */
export const resetTouches = () => touched.clear();

/** Whether a use at `now` is worth a write, and remembers it if so. */
export const shouldTouch = (id, now = Date.now()) => {
    const last = touched.get(id);
    if (last !== undefined && now - last < LAST_USED_GRANULARITY_MS) return false;

    touched.set(id, now);
    return true;
};

const presented = ({id, name, scope, created, lastUsed}) => ({id, name, scope, created, lastUsed});

/** Every token, without its digest. */
export const list = async () => (await apiTokens.findAll({order: [["id", "ASC"]]})).map(presented);

export const count = async () => apiTokens.count();

/** Issues a token: the row as the list shows it, plus the secret - the one time it exists. */
export const create = async (name) => {
    const token = generateToken();
    const row = await apiTokens.create({
        name: name.trim(),
        digest: digestOf(token),
        scope: SCOPE_RUN,
        created: new Date().toISOString(),
        lastUsed: null
    });

    return {...presented(row), token};
};

/** Revokes a token. False when there was none to revoke. */
export const remove = async (id) => (await apiTokens.destroy({where: {id}})) > 0;

export const findByDigest = async (digest) => apiTokens.findOne({where: {digest}});

/** Records a use, at most once per LAST_USED_GRANULARITY_MS per token. */
export const touch = async (id, now = Date.now()) => {
    if (!shouldTouch(id, now)) return false;

    await apiTokens.update({lastUsed: new Date(now).toISOString()}, {where: {id}});
    return true;
};

/** Every row with its digest, for the backup that carries the secrets. */
export const exportRows = async () => apiTokens.findAll({order: [["id", "ASC"]]});

/** Replaces the table with a backup's rows, already judged by importableToken. */
/**
 * The stored tokens, replaced by exactly these. Inside the caller's
 * transaction, so a restore refused halfway leaves the tokens it found.
 */
export const replaceAll = async (rows, transaction = undefined) => {
    await apiTokens.destroy({where: {}, transaction});
    touched.clear();
    if (rows.length > 0) await apiTokens.bulkCreate(rows, {transaction});
};

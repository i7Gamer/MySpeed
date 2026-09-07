import password from './password.js';
import * as tokens from '../controller/tokens.js';
import { isPreviewInstance } from '../util/previewMode.js';
import { PASSWORD_REQUIRED, SERVER_BUSY } from '../util/authOutcome.js';
import { toErrorMessage } from '../util/helpers.js';

/**
 * How long a caller is told to wait when the table could not be read - the
 * same answer the password gate gives when it is too busy to compare.
 */
const RETRY_AFTER_SECONDS = 1;

/**
 * The password gate, opened to an API token of one scope.
 *
 * A request carrying a MySpeed token - `Authorization: Bearer msp_…` - is
 * judged on the token alone: a known digest with the right scope is admitted
 * as the operator, anything else is refused. A browser never sends one, so
 * the refusal cannot start the password prompt the shared outcome type would
 * otherwise trigger. Every other request, Bearer headers of other shapes
 * included, goes to the password gate exactly as before - which is what keeps
 * a forward-auth proxy's JWT from locking its own users out.
 *
 * Wrong tokens spend no password budget. The password throttle exists because
 * each guess costs a bcrypt comparison and a short password can be guessed; a
 * token lookup is one indexed read against 256 bits of entropy, and charging
 * the shared per-address budget would let a stale token in a polling
 * automation lock the operator's own login out from behind the same NAT. The
 * general API rate limit bounds the request count.
 *
 * @param scope           the scope a token needs
 * @param allowViewAccess what the password gate is asked for callers without a token
 * @param deps            the collaborators, replaceable for the tests
 */
export const tokenOrPassword = (scope, allowViewAccess = false, {
    findByDigest = tokens.findByDigest, touch = tokens.touch, fallback = password(allowViewAccess),
    preview = isPreviewInstance
} = {}) => async (req, res, next) => {
    if (preview()) return fallback(req, res, next);

    const secret = tokens.parseBearer(req.headers.authorization);
    if (secret === null) return fallback(req, res, next);

    let row;
    try {
        row = await findByDigest(tokens.digestOf(secret));
    } catch (error) {
        // The table could not be read: the server's fault, and said so
        // rather than reported as a refused credential.
        console.error(`Could not check an API token: ${toErrorMessage(error)}`);
        return res.status(503).set("Retry-After", String(RETRY_AFTER_SECONDS))
            .json({message: "The API tokens could not be checked. Please try again", type: SERVER_BUSY});
    }

    if (row === null || row.scope !== scope)
        return res.status(401).json({message: "The API token was not accepted", type: PASSWORD_REQUIRED});

    req.viewMode = false;
    // The name and the id only - never the secret, which nothing after this
    // point has any business seeing.
    req.apiToken = {id: row.id, name: row.name};

    // A courtesy stamp, not a condition of entry.
    await touch(row.id).catch((error) =>
        console.error(`Could not record the use of API token "${row.name}": ${toErrorMessage(error)}`));

    return next();
};

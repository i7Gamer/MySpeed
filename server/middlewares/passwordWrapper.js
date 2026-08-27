import passwordMiddleware from './password.js';

/**
 * Runs the password check, letting one route answer a refusal with something
 * other than JSON - the opengraph banner, which has to send an image whatever
 * the session is.
 *
 * It does that by replacing res.send for the duration of the check. The
 * replacement is an own property on the response and nothing put it back, so it
 * outlived the check and stayed in place for the whole request: any later 401
 * on that response - raised by a route, or by the error handler that ends the
 * chain - went to the custom handler instead of being sent, because the patch
 * cannot tell which 401 it is looking at.
 *
 * Restoring costs the wrapper nothing. Every 401 the password middleware issues
 * is returned from its own body, and every path in it that calls next() returns
 * immediately afterwards - so by the time the chain moves on there is no
 * further 401 left for the patch to catch.
 */
const passwordWrapper = (allowViewAccess, customResponseHandler) => async (req, res, next) => {
    // Not bound: the original is called back with `res` as its receiver below,
    // and keeping it unbound is what lets the restore put back the very same
    // function object that was taken.
    const originalSend = res.send;

    const patched = function (body) {
        // Restored first on both paths, so a custom handler that sends - which
        // the banner one does - reaches the real send rather than this again.
        restore();

        // The password middleware has answered 401, so the caller's own answer
        // to that stands in for the JSON body.
        if (res.statusCode === 401 && typeof customResponseHandler === 'function')
            return customResponseHandler(req, res);

        return originalSend.call(res, body);
    };

    // Only ever takes back its own patch. Something further down the chain may
    // have wrapped res.send in the meantime, and restoring blindly would undo
    // that instead - putting back a function two layers stale.
    const restore = () => {
        if (res.send === patched) res.send = originalSend;
    };

    res.send = patched;

    try {
        // next is wrapped rather than passed through: the check is over the
        // moment the chain moves on, and that is where the patch has to go.
        await passwordMiddleware(allowViewAccess)(req, res, (err) => {
            restore();
            next(err);
        });
    } catch (err) {
        restore();
        next(err);
    } finally {
        // The middleware can also finish without sending and without calling
        // next - a refused rate-limit reservation is one - and the patch must
        // not survive that either.
        restore();
    }
};

export default passwordWrapper;

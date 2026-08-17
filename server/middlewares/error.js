const DEFAULT_STATUS = 500;

/**
 * The bottom of the 4xx range, and the status body-parser gives a body it could
 * not parse.
 *
 * One constant for both because it is one idea - "this is the caller's fault" -
 * and because the two have to agree: the status chosen for a SyntaxError below
 * decides which side of this boundary it lands on, and a malformed body filed
 * as a server error would be logged as though the instance had broken.
 */
const CLIENT_ERROR_STATUS = 400;

/**
 * Terminates the request, whatever went wrong.
 *
 * It was written for body-parser failures and its comment claimed it saw
 * nothing else - "mounted directly after express.json()" - which stopped being
 * true: app.js mounts it last, after every route, so it is also the catch-all
 * for anything a route throws or hands to next(). It has to answer all of it:
 * calling bare next() inside an error handler resumes the *normal* middleware
 * chain rather than ending the request, which used to hand anything that was
 * not a SyntaxError (415 unsupported charset, 413 entity too large) straight to
 * the route with req.body undefined.
 */
export default (err, req, res, next) => {
    // A malformed body is the caller's mistake whatever it arrived carrying.
    // body-parser stamps its own 400 on one, but a SyntaxError raised anywhere
    // else has no status, and defaulting that to 500 would file it as the
    // server's fault in the log below.
    const status = err instanceof SyntaxError
        ? CLIENT_ERROR_STATUS
        : (err.status ?? err.statusCode ?? DEFAULT_STATUS);

    const isClientError = status >= CLIENT_ERROR_STATUS && status < DEFAULT_STATUS;

    /**
     * The operator's copy, since the caller's says nothing.
     *
     * A 5xx answers with a fixed sentence and no detail, on purpose - and
     * nothing wrote the detail down either, so an unhandled throw from a route
     * left no trace at all on a running server. Logged before the headersSent
     * branch below, which abandons the response rather than answering it: that
     * is the case with the least to show for itself and the most worth saying.
     *
     * Client errors stay out of the log. They are as frequent as anyone cares
     * to make them, and a stranger who can write to the operator's disk by
     * sending bad JSON has been handed something they should not have.
     */
    if (!isClientError) console.error("Unhandled route error:", err);

    if (res.headersSent) return next(err);

    if (err instanceof SyntaxError)
        return res.status(CLIENT_ERROR_STATUS).json({message: "You need to provide a valid JSON body"});

    // Only body-parser's own wording is echoed back, and only for client
    // errors - anything else could carry internals.
    res.status(status).json({message: isClientError && err.message ? err.message : "The request could not be processed"});
};

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
 * The range a status has to fall in to be one.
 *
 * Narrower than Express itself allows, which is anything up to 999. These are
 * the codes HTTP defines, and a status outside them reaching this handler is a
 * value something got wrong rather than a code worth forwarding.
 */
const LOWEST_HTTP_STATUS = 100;
const HIGHEST_HTTP_STATUS = 599;

/**
 * A status the response can actually be given, or 500.
 *
 * res.status() throws for a non-integer and for one out of range - and thrown
 * from inside the error handler, that is the one throw with nowhere left to go:
 * the response is abandoned half-written and the caller waits for an answer
 * that never comes.
 *
 * Normalised once, here, rather than at the res.status() call below. The same
 * number decides whether the failure is logged as the server's fault and
 * whether the error's own message may be echoed back, and those three answers
 * have to agree - clamping only at the end would log a NaN as a server error
 * and then answer 500 for something it had already treated as the caller's
 * mistake.
 */
const asStatus = (value) =>
    Number.isInteger(value) && value >= LOWEST_HTTP_STATUS && value <= HIGHEST_HTTP_STATUS
        ? value
        : DEFAULT_STATUS;

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
        : asStatus(err.status ?? err.statusCode);

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
     *
     * The stack, not the error object. console.error runs util.inspect over an
     * Error, which prints its own enumerable properties beside the frames -
     * and sequelize's DatabaseError copies the failed statement's bind
     * parameters onto itself. The integrations table's `data` column is where
     * every downstream credential lives, so a database failure on an
     * integration write printed the telegram bot token, the webhook URL and the
     * influx token into the log. On the Windows service that log is a file on
     * disk, and it is the first thing anyone attaches to a bug report.
     *
     * util/errorHandler.js records `reported.stack` for the same reason, which
     * is why nothing ever leaked through that path.
     */
    if (!isClientError) console.error("Unhandled route error:", err?.stack ?? err?.message ?? String(err));

    if (res.headersSent) return next(err);

    if (err instanceof SyntaxError)
        return res.status(CLIENT_ERROR_STATUS).json({message: "You need to provide a valid JSON body"});

    // Only body-parser's own wording is echoed back, and only for client
    // errors - anything else could carry internals.
    res.status(status).json({message: isClientError && err.message ? err.message : "The request could not be processed"});
};

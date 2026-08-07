const DEFAULT_STATUS = 500;

/**
 * Terminates body-parser failures.
 *
 * Mounted directly after express.json(), so the only errors that reach it come
 * from parsing the request body. It has to answer every one of them: calling
 * bare next() inside an error handler resumes the *normal* middleware chain
 * rather than ending the request, which used to hand anything that was not a
 * SyntaxError (415 unsupported charset, 413 entity too large) straight to the
 * route with req.body undefined.
 */
export default (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof SyntaxError)
        return res.status(400).json({message: "You need to provide a valid JSON body"});

    const status = err.status ?? err.statusCode ?? DEFAULT_STATUS;
    const isClientError = status >= 400 && status < DEFAULT_STATUS;

    // Only body-parser's own wording is echoed back, and only for client
    // errors - anything else could carry internals.
    res.status(status).json({message: isClientError && err.message ? err.message : "The request could not be processed"});
};

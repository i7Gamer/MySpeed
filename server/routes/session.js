import express from 'express';
import bcrypt from 'bcryptjs';
import * as config from '../controller/config.js';
import { matchesSetupToken } from '../util/setupToken.js';
import { createSession, destroySession, isValidSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '../util/session.js';
import { expiredCookies, readCookies, serialiseCookie } from '../util/cookies.js';
import {
    ATTEMPT_BUSY, ATTEMPT_LOCKED_OUT, clearFailedAttempts, reserveAttempt
} from '../middlewares/password.js';
import { PASSWORD_REQUIRED, SERVER_BUSY, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS } from '../util/authOutcome.js';

const app = express.Router();

/**
 * Exchanges the password for a session cookie.
 *
 * The client used to keep the password in localStorage and replay it on every
 * request; this is what lets it stop. Unauthenticated by necessity - it is the
 * way in - so it runs behind the same failed-attempt throttle as the password
 * middleware, sharing one counter so an attacker cannot get a fresh budget by
 * switching between the two.
 */
app.post("/", async (req, res) => {
    const supplied = req.body?.password;
    if (typeof supplied !== "string" || supplied === "")
        return res.status(400).json({message: "You need to provide a password"});

    // Refused or reserved in one atomic call - see reserveAttempt for why the
    // check and the write must not be separable. After the body validation, not
    // before it: only a request carrying a guess costs bcrypt work, so only one
    // spends the budget, and a locked-out caller with no usable body is told
    // about the body - the answer they can act on.
    const admission = reserveAttempt(req);

    if (admission.outcome === ATTEMPT_LOCKED_OUT)
        return res.status(429).json({
            message: "Too many failed password attempts. Please try again later",
            type: TOO_MANY_ATTEMPTS
        });

    // Busy is not a refused credential: the caller's own correct sign-ins can
    // briefly fill the in-flight slots, and telling them the password was wrong
    // would send them looking for a problem that does not exist.
    if (admission.outcome === ATTEMPT_BUSY)
        return res.status(503).set("Retry-After", "1")
            .json({message: "The server is busy checking passwords. Please try again", type: SERVER_BUSY});

    let valid = false;
    let compared = false;
    let unconfigured;

    try {
        const passwordHash = await config.getValue("password");
        unconfigured = passwordHash === config.NO_PASSWORD;

        valid = unconfigured
            ? matchesSetupToken(supplied)
            : await bcrypt.compare(supplied, passwordHash);
        compared = true;
    } finally {
        // Released whatever happened, and counted as a failure only if a
        // comparison actually ran and the guess was wrong. A correct password
        // never spends the failure budget, and neither does a database error
        // on the way to checking one.
        admission.settle({failed: compared && !valid ? 1 : 0});
    }

    if (!valid) {
        // Which credential was wrong, not merely that one was: an instance with
        // no password rejects a mistyped setup token, and telling its operator
        // the password was incorrect would send them looking for one that does
        // not exist.
        return res.status(401).json({
            message: unconfigured ? "Incorrect setup token" : "Incorrect password",
            type: unconfigured ? SETUP_TOKEN_REQUIRED : PASSWORD_REQUIRED
        });
    }

    clearFailedAttempts(req);

    res.setHeader("Set-Cookie", serialiseCookie(SESSION_COOKIE, createSession(), {
        req,
        maxAge: SESSION_MAX_AGE_SECONDS,
        secure: req.secure
    }));

    res.json({message: "Signed in"});
});

/** Whether this browser already holds a usable session. */
app.get("/", (req, res) => res.json({active: readCookies(req, SESSION_COOKIE).some(isValidSession)}));

app.delete("/", (req, res) => {
    // Every id the browser sent, not the first. Under BASE_PATH this instance
    // answers on two routes and can have written a cookie at each, so a browser
    // may hold two live sessions - and destroying one of them is a sign-out that
    // reports success while the next request is still authenticated.
    for (const token of readCookies(req, SESSION_COOKIE)) destroySession(token);

    // Max-Age=0 is what actually removes it from the browser, at every scope a
    // sign-in could have used - for the same reason.
    res.setHeader("Set-Cookie", expiredCookies(SESSION_COOKIE, {secure: req.secure}));
    res.json({message: "Signed out"});
});

export default app;

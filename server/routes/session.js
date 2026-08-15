import express from 'express';
import bcrypt from 'bcryptjs';
import * as config from '../controller/config.js';
import { matchesSetupToken } from '../util/setupToken.js';
import { createSession, destroySession, isValidSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '../util/session.js';
import { readCookie, serialiseCookie } from '../util/cookies.js';
import { clearFailedAttempts, isThrottled, recordFailedAttempt } from '../middlewares/password.js';
import { PASSWORD_REQUIRED, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS } from '../util/authOutcome.js';

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
    if (isThrottled(req))
        return res.status(429).json({
            message: "Too many failed password attempts. Please try again later",
            type: TOO_MANY_ATTEMPTS
        });

    const supplied = req.body?.password;
    if (typeof supplied !== "string" || supplied === "")
        return res.status(400).json({message: "You need to provide a password"});

    // Charged before the comparison, and refunded below if it turns out to be
    // right. Recorded afterwards it sat behind two awaits, so a batch of
    // requests arriving together all read the count before any of them raised
    // it and the shared limit bounded only the guesses that queued.
    recordFailedAttempt(req);

    const passwordHash = await config.getValue("password");
    const unconfigured = passwordHash === config.NO_PASSWORD;

    const valid = unconfigured
        ? matchesSetupToken(supplied)
        : await bcrypt.compare(supplied, passwordHash);

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
        maxAge: SESSION_MAX_AGE_SECONDS,
        secure: req.secure
    }));

    res.json({message: "Signed in"});
});

/** Whether this browser already holds a usable session. */
app.get("/", (req, res) => res.json({active: isValidSession(readCookie(req, SESSION_COOKIE))}));

app.delete("/", (req, res) => {
    destroySession(readCookie(req, SESSION_COOKIE));

    // Max-Age=0 is what actually removes it from the browser.
    res.setHeader("Set-Cookie", serialiseCookie(SESSION_COOKIE, "", {maxAge: 0, secure: req.secure}));
    res.json({message: "Signed out"});
});

export default app;

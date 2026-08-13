/**
 * Turning the server's refusal into the question to ask about it.
 *
 * These names mirror server/util/authOutcome.js. A 401 is not one situation:
 * an instance with no password wants the setup token from its log, an instance
 * with one wants the password, and a caller who has been refused too often
 * wants neither - it wants a minute. Asking "your password" in all three is
 * what left an operator staring at a box they had nothing to type into.
 */
export const SETUP_TOKEN_REQUIRED = "SETUP_TOKEN_REQUIRED";
export const PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
export const TOO_MANY_ATTEMPTS = "TOO_MANY_ATTEMPTS";

export const PROMPT_SETUP_TOKEN = "setup-token";
export const PROMPT_PASSWORD = "password";
export const PROMPT_THROTTLED = "throttled";

/**
 * Which question a given refusal calls for.
 *
 * Anything unrecognised asks for the password, which is what the interface did
 * before any of this existed. A node running an older MySpeed answers 401 with
 * no type at all and the parent proxies that through unchanged, so an absent
 * type has to keep working rather than break the dialog.
 */
export const promptFor = (type) => {
    switch (type) {
        case SETUP_TOKEN_REQUIRED:
            return PROMPT_SETUP_TOKEN;
        case TOO_MANY_ATTEMPTS:
            return PROMPT_THROTTLED;
        default:
            return PROMPT_PASSWORD;
    }
};

/**
 * The line a refusal earns in a prompt that re-asks in place.
 *
 * The admin login keeps one dialog open rather than switching between three,
 * so the refusal has to speak through its description - and "the password you
 * entered is incorrect" was that line for every refusal, including a lockout,
 * where it invited retyping into a throttle that answers nothing, and an
 * instance whose password was removed mid-session, where no password would
 * ever work again. The setup-token case gets the full situation rather than
 * "that is not the token": the operator typed a password, and what changed is
 * that the instance no longer has one.
 */
export const refusalDescriptionKey = (type) => {
    switch (promptFor(type)) {
        case PROMPT_THROTTLED:
            return "dialog.throttled.description";
        case PROMPT_SETUP_TOKEN:
            return "dialog.setup_token.description";
        default:
            return "dialog.password.wrong";
    }
};

/**
 * What the page says once the prompt has been dismissed.
 *
 * The prompt refused to close, because dismissing it left the config {} and the
 * dashboard behind it empty. That held until the question became unanswerable:
 * an instance with no password asks for a token printed in a server log, and an
 * operator who cannot reach that log had a modal they could neither answer nor
 * leave. Dismissing lands on this notice instead, so closing the prompt gives
 * up the box without giving up the explanation - and the button opens it again.
 *
 * The keys are the prompt's own wherever they already say the right thing.
 * They are translated in sixteen locales, and a second copy of "Password
 * required" would drift from the first the day either is reworded.
 */
export const lockedNoticeKeys = (type) => {
    switch (promptFor(type)) {
        case PROMPT_SETUP_TOKEN:
            return {
                title: "dialog.setup_token.title",
                description: "dialog.setup_token.description",
                // The token is reprinted whenever a request is refused, which
                // turns "hunt through the log" into "reload and read the end
                // of it". Nothing else in the interface says so.
                hint: "locked.token_hint",
                action: "locked.enter_token"
            };
        case PROMPT_THROTTLED:
            return {
                title: "dialog.throttled.title",
                description: "dialog.throttled.description",
                // Nothing to type until the window expires, so the button
                // retries rather than reopening a box that answers nothing.
                action: "dialog.retry"
            };
        default:
            return {
                title: "dialog.password.title",
                description: "locked.password_desc",
                action: "dialog.login"
            };
    }
};

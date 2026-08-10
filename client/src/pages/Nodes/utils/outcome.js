/**
 * What the nodes API answered, classified for the dialogs.
 *
 * The create dialog used to branch on three response types and fall off the
 * end for everything else: submitting the empty form (MISSING_PARAMETERS) did
 * nothing at all, and the server's specific refusals - "This host is not in
 * ALLOWED_NODE_HOSTS" among them - were collapsed into a bare red border with
 * no words. Everything unrecognised is an error with the server's own message,
 * so no answer is silent again.
 */
export const OUTCOME_CREATED = "created";
export const OUTCOME_PASSWORD = "password";
export const OUTCOME_INVALID_URL = "invalid-url";
export const OUTCOME_ERROR = "error";

export const describeNodeOutcome = (body) => {
    switch (body?.type) {
        case "NODE_CREATED":
            return {kind: OUTCOME_CREATED};
        case "PASSWORD_REQUIRED":
            return {kind: OUTCOME_PASSWORD};
        case "INVALID_URL":
            return {kind: OUTCOME_INVALID_URL, message: body.message ?? null};
        default:
            return {kind: OUTCOME_ERROR, message: body?.message ?? null};
    }
};

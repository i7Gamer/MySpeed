/**
 * The check behind the second password box.
 *
 * A chosen password is hashed the moment it arrives, and the server never sees
 * it again - so a typo in the one box the dialog used to have became the
 * password, and nothing downstream could tell. That lockout has no way back
 * from the interface either: loopback access and the setup token both only
 * apply to an instance with *no* password, so a password nobody knows is only
 * cleared by editing the database by hand. Typing it twice is the only place
 * the mistake can still be caught.
 */
export const PASSWORD_MISMATCH = "update.password_mismatch";

/**
 * Whether the two boxes disagree, as a translatable key, or null when they do
 * not.
 *
 * Both empty is not a mismatch: an empty password box means the operator is
 * only changing the access level, which is a save the dialog has always
 * allowed. Either box alone is - a password typed into the confirmation only
 * would have saved nothing at all behind a success toast.
 *
 * Compared verbatim. Trimming would defeat the point, since a stray leading or
 * trailing space is stored as part of the password and is precisely the typo
 * that cannot be seen.
 */
export const passwordConfirmationProblem = (password, confirmation) => {
    if (!password && !confirmation) return null;

    return password === confirmation ? null : PASSWORD_MISMATCH;
};

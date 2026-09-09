let revision = 0;

/** Invalidates pending access-policy decisions without revoking signed-in sessions. */
export const authPolicyRevision = () => revision;

/** Called only after a policy write or replacement has committed successfully. */
export const advanceAuthPolicy = () => { revision++; };

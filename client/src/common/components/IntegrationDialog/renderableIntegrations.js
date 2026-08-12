/**
 * The stored rows this dialog is actually able to draw.
 *
 * A row whose integration no longer exists has no definition, and the dialog
 * handed that straight to IntegrationCard - which reads `integrationDef.fields`
 * inside a useState initialiser, so an unknown name did not render a broken
 * card, it threw during render and took the whole integrations dialog with it.
 * The only way back was to delete the row from the database by hand, which is
 * not something the dialog it had broken could be used to do.
 *
 * Such rows are real: the server's withoutSecrets() carries a comment about "a
 * stale row for an integration that has since been removed", so an integration
 * disappearing in an upgrade is a case the backend already knows it must
 * survive.
 *
 * Object.hasOwn rather than a plain lookup, for the same reason the server's
 * getIntegration() uses it: `definitions["toString"]` answers with
 * Object.prototype's, which is truthy, so a row named after a prototype member
 * would pass a bare truthiness check and hand the card a function to read
 * `.fields` off.
 */
export const renderableIntegrations = (active, definitions) => {
    if (!definitions) return [];

    return (active ?? []).filter((item) =>
        item?.name !== undefined && Object.hasOwn(definitions, item.name));
};

/**
 * The row the target editor sends, built from what its fields hold.
 *
 * Pure and apart from the dialog, the way frequencyStateFrom is: what the
 * editor writes is judged by the server against the row it *would become* -
 * so a field that goes out as the wrong shape is refused with a message about
 * a value the operator cannot see, and the three sentinels here ("none" for an
 * unset select, "" for a cleared number, null for inherit) are exactly where
 * that goes wrong.
 */

import {takesEndpoint, takesServerId} from "./providerFields.js";

// The select and the free-text id share a stored value, and "none" is what
// both use for "let the provider choose" - it is not a server id.
const AUTOMATIC = "none";

/**
 * One optimal value, or null to inherit the instance-wide setting.
 *
 * Blank while the own-optimals toggle is on means "inherit this one metric" -
 * resolveLimits falls back per metric, so a target can pin its download and
 * leave its ping global. With the toggle off, all three inherit.
 */
export const optimalOrNull = (enabled, value) => {
    if (!enabled || value === "" || value === null || value === undefined) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Whether the typed optimals can be saved at all, said before the server has
 * to say it. The server refuses anything that is not a number above zero -
 * `optimalProblem` in controller/targets.js - and the fields beside these
 * already hold their own rules inline, so a typed 0 earning a red toast after
 * the fact was the one field answering a different way. A blank inherits and
 * stays fine; a value optimalOrNull would silently turn into "inherit"
 * ("abc") is refused too, because a save that quietly drops what was typed
 * reads as a save.
 */
export const optimalAccepted = (value) => {
    if (value === "" || value === null || value === undefined) return true;

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
};

export const optimalsAccepted = ({ownOptimals, optimalPing, optimalDownload, optimalUpload}) =>
    !ownOptimals || [optimalPing, optimalDownload, optimalUpload].every(optimalAccepted);

/**
 * @param fields the editor's state, exactly as it holds it
 * @returns the JSON body for PUT /targets or PATCH /targets/:id
 */
export const targetBody = ({name, provider, serverId, endpoint, alerts, ownOptimals,
                               optimalPing, optimalDownload, optimalUpload}) => {
    // Judged exactly as it is sent. Compared raw and sent trimmed, " none"
    // walked past the sentinel check here and went to the server as the
    // literal host "none" - a row whose editor reopens with a dead button,
    // because the seeded value now *is* the sentinel.
    const typedEndpoint = typeof endpoint === "string" ? endpoint.trim() : "";

    return {
        // Trimmed, because the server measures the name against its length limit
        // and a name of spaces is not a name.
        name: (name ?? "").trim(),
        provider,
        // Held to the providers that have a list to pin from, for the same reason
        // as the endpoint below: the server judges the row this would become.
        serverId: !takesServerId(provider) || serverId === AUTOMATIC || !serverId ? null : serverId,
        // Only the providers that take one. Sent for any other it would be
        // refused - the server judges the merged row, and an endpoint on a
        // provider that takes none is exactly what it refuses.
        endpoint: takesEndpoint(provider) && typedEndpoint && typedEndpoint !== AUTOMATIC
            ? typedEndpoint : null,
        alerts,
        optimalPing: optimalOrNull(ownOptimals, optimalPing),
        optimalDownload: optimalOrNull(ownOptimals, optimalDownload),
        optimalUpload: optimalOrNull(ownOptimals, optimalUpload)
    };
};

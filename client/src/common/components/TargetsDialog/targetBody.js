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

import {takesEndpoint, takesServerId, takesTuning} from "./providerFields.js";

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
 * One tuning value, or null to run the registry's own default.
 *
 * Blank is the field left alone, not a value of zero - the same sentinel
 * optimalOrNull keeps, and for the same reason: the column is nullable and
 * null is what the runner reads as "no opinion". Held to the provider as
 * well, because the server judges the row this would become and refuses a
 * run's shape on a provider that decides its own.
 */
export const tuningOrNull = (provider, value) => {
    if (!takesTuning(provider) || value === "" || value === null || value === undefined) return null;

    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
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
 * The share of its own median a target alerts below, or null for no baseline.
 *
 * optimalOrNull's shape, and null means the same thing it does there: the
 * column is the whole switch, so a target with no baseline is one whose column
 * is null rather than one carrying a percentage nobody reads. A value left
 * behind by switching the toggle off therefore must not travel - the door
 * would take it and the target would start alerting on a setting the dialog
 * shows as off.
 *
 * Not held to the provider, unlike the run-shape fields: a baseline is about
 * the measurements a target records rather than about how it records them, so
 * every provider has one.
 */
export const baselineOrNull = (enabled, value) => {
    if (!enabled || value === "" || value === null || value === undefined) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/**
 * @param fields the editor's state, exactly as it holds it
 * @returns the JSON body for PUT /targets or PATCH /targets/:id
 */
export const targetBody = ({name, provider, serverId, endpoint, alerts, ownOptimals,
                               optimalPing, optimalDownload, optimalUpload,
                               iperfDuration, iperfStreams, iperfUdp, iperfBitrate,
                               baselineAlerts, baselinePercent}) => {
    // Datagrams, for the one provider that offers them. Stated either way
    // rather than left out: the column is NOT NULL and false is what every
    // target is, so there is no "unset" for this one to mean.
    const udp = takesTuning(provider) && Boolean(iperfUdp);
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
        optimalUpload: optimalOrNull(ownOptimals, optimalUpload),
        // How the run itself is shaped, for the one provider that lets a
        // target say - null everywhere else, which is what the door takes
        // and what the runner reads as its own default.
        iperfDuration: tuningOrNull(provider, iperfDuration),
        // Null under UDP, because the shipped build cannot carry a datagram
        // run over more than one stream and the door refuses the pair. A
        // target that had eight and then turned UDP on would otherwise be
        // unsaveable with nothing in the dialog saying which field to fix.
        iperfStreams: udp ? null : tuningOrNull(provider, iperfStreams),
        iperfUdp: udp,
        // And the rate belongs to the mode: sent only when datagrams are, so a
        // value left behind by switching the toggle back off does not travel
        // with the save into a refusal.
        iperfBitrate: udp ? tuningOrNull(provider, iperfBitrate) : null,
        // What "slower than usual" means for this target, or null for a target
        // that does not ask - see baselineOrNull.
        baselinePercent: baselineOrNull(baselineAlerts, baselinePercent)
    };
};

// The first target wears the bare name, so the numbering the next one takes
// starts at two - "Ookla" and "Ookla 2", not "Ookla 1".
const NAME_SUFFIX_START = 2;

/**
 * A name a new target can be saved under straight away: the provider's own,
 * numbered past whatever already wears it.
 *
 * The editor asked for a name and offered none, so the button that adds the
 * target was dead the moment the dialog opened. The provider's name is what
 * nearly every operator types anyway - it just has to be free, because the
 * server refuses a name another target already wears, and a dialog that opens
 * pre-filled with a value the door rejects is a worse welcome than a dead
 * button.
 *
 * Judged exactly as nameTaken judges it - trimmed, and case-sensitively. A
 * looser rule here fails in the harmful direction: a name this thinks is free
 * and the server refuses. The first free number is taken rather than the next
 * one up, so deleting "Ookla 2" hands its name back to the target after it.
 *
 * @returns {string} the free name, or "" when there is nothing to build one
 *                   from - which leaves the field empty and the button honest
 */
export const uniqueTargetName = (base, targets) => {
    const wanted = typeof base === "string" ? base.trim() : "";
    if (wanted === "") return "";

    const taken = new Set((Array.isArray(targets) ? targets : [])
        .map((target) => typeof target?.name === "string" ? target.name.trim() : null)
        .filter((name) => name !== null));

    if (!taken.has(wanted)) return wanted;

    for (let suffix = NAME_SUFFIX_START; ; suffix++)
        if (!taken.has(`${wanted} ${suffix}`)) return `${wanted} ${suffix}`;
};

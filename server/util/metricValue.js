/**
 * A stored column as a number a gauge will accept, or null when it is not one.
 *
 * prom-client throws "Value is not a valid number" for anything that is not a
 * number, and the throw lands before the scrape is served - so one unreadable
 * value in the newest test answered 500 for every scrape until a newer test
 * arrived. Prometheus reads a 500 as the target being down: no sample is
 * recorded, every myspeed_* series goes stale, and the alert it raises names
 * the exporter rather than the row. The route already knew this for a null
 * serverId; null is simply not the only way a column comes back unreadable.
 *
 * A numeric string is read rather than refused, because that is what an
 * imported history holds: sqlite stores whatever it is handed and returns it
 * unchanged, so a row restored before the import validated its columns can
 * carry "42" where a number belongs. That is a measurement somebody took, and
 * dropping the series for it would lose a metric that is really there.
 *
 * Zero and -1 pass: zero is a reading, and the failure placeholder is for the
 * caller to recognise - collect() reports a failed test through its own gauge
 * rather than by declining to answer.
 */
export const metricValue = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;

    // Only a string, and only one that is entirely a number. Number("") is 0
    // and Number([]) is 0, so a bare cast would turn an empty column into a
    // confident zero - which on a speed reads as a line that delivered nothing.
    if (typeof value !== "string" || value.trim() === "") return null;

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
};

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

/**
 * An optional figure, or null when it is not one.
 *
 * The nullable columns - jitter, packet loss, the two loaded latencies - ask a
 * different question from the required trio and get a different answer. Null
 * already means "nobody measured this", so a negative one has an honest home to
 * go to, and failing a whole run over a jitter of -0.2 would throw away a
 * perfectly good throughput measurement - the opposite of what #875 is about.
 *
 * A measured zero is kept, for the same reason it is kept everywhere: a line
 * that lost no packets is a fact, not an absence.
 *
 * Lives beside metricValue, its only dependency, so the string helpers that
 * read through it do not drag testOutcome's sequelize import into every
 * integration - it is re-exported from testOutcome.js, where the failure
 * predicates it is read beside live, and importers may use either door.
 */
export const usableFigure = (value) => {
    const figure = metricValue(value);

    return figure === null || figure < 0 ? null : figure;
};

/**
 * The latency a run records when it measured none.
 *
 * A successful test can still carry a latency nobody took: parseCloudflare
 * answers `round(avg_latency_ms) ?? 0` on its success path, so a run whose
 * latency block held no average stores exactly 0, and parseIperf3 answers the
 * same for a run whose handshake spread could not be taken. The column is NOT
 * NULL, so 0 is the only sentinel available - and it is a safe one, because no
 * connection produces it. A real sub-millisecond line stores the decimals it
 * measured: the column has held them since migration 0010, and a genuine 0.24
 * arrives as 0.24.
 *
 * Which is why the comparison stays exact. Widened to "under a millisecond" it
 * would discard every fibre and LAN reading along with the fabrication.
 */
export const UNMEASURED_LATENCY = 0;

/**
 * Whether a stored latency is a reading.
 *
 * Lives beside the readers rather than beside the failure predicates it was
 * written next to, and for the reason usableFigure moved here before it: the
 * alert gate judged this one way and the statistics another, so the same
 * fabricated zero was refused by the notification and averaged into the figure
 * on the page - and the two metric sinks, which are integrations and cannot
 * reach the sequelize side of the wall, published it as a perfect 0 ms line.
 * One home, every reader.
 */
export const isMeasuredLatency = (value) =>
    typeof value === "number" && Number.isFinite(value) && value !== UNMEASURED_LATENCY;

/**
 * A stored ping that was measured, as the figure - or null.
 *
 * The whole question in one place, because it was being assembled twice: the
 * statistics coerced with usableFigure and then asked isMeasuredLatency, the
 * recommendation sample asked isMeasuredLatency of an already-coerced value
 * and refused the placeholder with a comparison of its own. The spellings
 * agreed - the comments on each even said so - but agreement held by prose is
 * how the alert gate and the statistics came to disagree about the fabricated
 * zero in the first place.
 *
 * usableFigure and not bare metricValue for the coercion: metricValue keeps -1
 * for its Prometheus caller to judge, and no caller of this reader judges it -
 * fed into a min, a chart or an hourly bucket, the placeholder is a reading of
 * minus one millisecond. isMeasuredLatency then refuses the fabricated zero,
 * in both spellings, since usableFigure reads "0" as the number it is. Null
 * for everything refused, which every caller treats as the gap it is.
 */
export const measuredPing = (value) => {
    const ping = usableFigure(value);

    return isMeasuredLatency(ping) ? ping : null;
};

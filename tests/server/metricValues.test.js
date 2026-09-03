import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, listSources, readSource } from "../helpers/source.js";
import { measuredPing, metricValue, usableFigure } from "../../server/util/metricValue.js";
import { isFailedTest, isSuccessfulTest } from "../../server/util/testOutcome.js";

/**
 * A gauge is set from a stored row, and a stored row is not always a number.
 *
 * prom-client throws "Value is not a valid number" for anything that is not
 * one, and the throw happens before the scrape is served - so a single
 * unreadable value in the newest test answered 500 for every scrape until a
 * newer test landed. Prometheus reads that as the exporter being down: no
 * sample is recorded, every myspeed_* series goes stale, and the alert blames
 * the wrong thing. The route already learned this once for a null serverId;
 * what it did not learn is that null is not the only way a column arrives
 * unreadable.
 *
 * Two ways in, both real:
 *
 *   - serverId was the one numeric column importTests never checked, so
 *     PUT /api/storage/tests/history could write "auto" into it today.
 *   - Every measurement column can hold a string on a history imported before
 *     that validation existed, which createRecommendations guards against by
 *     name and this route did not.
 */
describe("metricValue", () => {
    it("passes an ordinary measurement through", () => {
        assert.equal(metricValue(12.5), 12.5);
        assert.equal(metricValue(0), 0, "zero is a measurement, not an absence");
        assert.equal(metricValue(-1), -1, "the failure placeholder is the caller's to judge");
    });

    it("refuses what a gauge cannot take", () => {
        for (const value of ["auto", "", null, undefined, NaN, Infinity, -Infinity, {}, []])
            assert.equal(metricValue(value), null, `${JSON.stringify(value)} was handed to a gauge`);
    });

    // Defensive, not a live database shape: sqlite's REAL affinity converts
    // well-formed numeric text at write for these DOUBLE columns, and MySQL
    // does the same, so what actually survives storage is non-numeric junk
    // like "NaN" - refused above. The digits-as-text reading stands anyway,
    // because this is the one shared judgement every reader leans on, and a
    // reader that would misread a numeric string is one storage-coercion
    // trivia away from a lost metric.
    it("reads a numeric string, in case one ever arrives", () => {
        assert.equal(metricValue("42"), 42);
        assert.equal(metricValue("0.4"), 0.4);
    });
});

/**
 * The recommendation sample reads through the same judgement.
 *
 * createRecommendations filtered with bare Number.isFinite while the
 * statistics moved to metricValue - two predicates over the same rows, and the
 * two surfaces they feed sit on one page. No behavioural case can pin this
 * through the database (both backends coerce well-formed numeric text at
 * write, so a seeded string row proves storage rather than the filter), which
 * is why it is held at the source: the three measurement reads go through
 * metricValue, and no bare finite check decides the sample.
 */
describe("the recommendation sample", () => {
    const speedtestTask = readSource("server/tasks/speedtest.js");
    const body = bodyOf(speedtestTask, "export const createRecommendations");

    it("reads its three figures through the shared readers", () => {
        assert.match(body, /measuredPing\(entry\.ping\)/,
            "the sample's ping is judged by a different rule than the page beside it");
        // usableFigure, not metricValue, for the speeds: metricValue keeps
        // the -1 placeholder for its Prometheus caller to judge, and fed to
        // max against the 0 the accumulators start from, a placeholder sample
        // published a 0 Mbit/s optimum - the behavioural pin lives in
        // tests/integration/recommendations.test.js.
        assert.match(body, /usableFigure\(entry\.download\)/);
        assert.match(body, /usableFigure\(entry\.upload\)/);
    });

    it("no longer keeps a bare finite check of its own", () => {
        // All three columns, not one: a reintroduced Number.isFinite(upload)
        // is the same divergence the message names. The accumulator's own
        // Number.isFinite(recommendations.ping) stays legitimate - it judges
        // the untouched Infinity sentinel, not a row - so the pattern names
        // the row reads rather than banning the call outright.
        assert.doesNotMatch(body, /Number\.isFinite\((entry\.)?(ping|download|upload)\)/,
            "a second predicate over the same rows is what diverged");
    });
});

/**
 * The three readers every consumer of a stored column shares.
 *
 * They answer three different questions about the same nine columns and the
 * differences are the point: metricValue keeps -1 for a caller that judges the
 * placeholder itself, usableFigure refuses it, and measuredPing refuses the
 * fabricated zero as well. What must never happen is a fourth answer written
 * inline at a call site, which is how the alert gate and the statistics came to
 * disagree about the same row.
 */
const SHARED_READERS = ["metricValue", "usableFigure", "measuredPing"];

/**
 * The leaf the integrations are allowed to import.
 *
 * helpers.js says it in as many words at its own import: every notifier pulls
 * its string helpers from here, and testOutcome.js - the historical home of
 * these readers - imports sequelize for its two where clauses. So the readers a
 * notifier needs live in the dependency-free file and testOutcome re-exports
 * them, rather than the other way round.
 */
describe("the shared readers' layer", () => {
    it("keeps the leaf free of dependencies", () => {
        const source = readSource("server/util/metricValue.js");

        assert.doesNotMatch(source, /^\s*import\b/m,
            "metricValue.js imports something, so every notifier now imports it too");
    });

    it("is where the latency readers live, with testOutcome as the other door", () => {
        const leaf = readSource("server/util/metricValue.js");
        const outcome = readSource("server/util/testOutcome.js");

        for (const name of ["UNMEASURED_LATENCY", "isMeasuredLatency", "measuredPing"]) {
            assert.match(leaf, new RegExp(`export const ${name}\\b`),
                `${name} is not in the leaf, so an integration reading it drags sequelize in`);
            assert.doesNotMatch(outcome, new RegExp(`export const ${name}\\b`),
                `${name} is declared twice, which is what the one home exists to stop`);
        }

        // The historical door stays open: every reader of the failure
        // predicates found these beside them, and the move must not break a
        // single import.
        assert.match(outcome, /export \{[^}]*\bmeasuredPing\b[^}]*\}/,
            "testOutcome no longer re-exports what moved out of it");
    });

    it("keeps sequelize out of every integration", () => {
        for (const file of listSources("server/integrations")) {
            const source = readSource(`server/integrations/${file}`);

            assert.doesNotMatch(source, /from ["'][^"']*testOutcome\.js["']/,
                `${file} imports testOutcome, which imports sequelize`);
            assert.doesNotMatch(source, /from ["']sequelize["']/, `${file} imports sequelize directly`);
        }
    });
});

/**
 * And the route sets nothing it has not read through one of them.
 *
 * Two halves, because two different things can break. The scans below say that
 * every column reaches a gauge through a shared reader rather than through a
 * spelling of the route's own; the behavioural cases beneath them say what
 * those readers then do with the two values that reach a gauge as a lie - the
 * fabricated 0 ms latency and a lone -1 on a row that succeeded.
 */
describe("the metrics route", () => {
    // The per-target rework split the scrape in two: collect() walks the
    // targets, setSeries() sets one target's gauges. The guards being pinned
    // live where the values are read, so both bodies are the subject.
    const source = readSource("server/routes/prometheus.js");
    const setSeriesBody = bodyOf(source, "const setSeries = (latest");
    const collect = bodyOf(source, "const collect = async") + setSeriesBody;

    /*
     * Every numeric column the route reads, checked at the point it is read
     * rather than at the point it is set.
     *
     * Scanning for `someGauge.set(...)` covered one of the seven set calls in
     * this body: `timeGauge.set(labels, time)` hands over a local, and the
     * shared `measured()` helper sets through a lowercase parameter that no
     * pattern requiring a capital G can match. So the scan came back empty for
     * reasons that had nothing to do with the guard, and stayed empty with the
     * guard removed. Reading from the column end instead covers all of them,
     * because a column is the only place an unreadable value can enter.
     *
     * The row is `\w+` rather than the literal `latest`, which is how serverId
     * sat in this list reading nothing at all: the one place it is read spells
     * the row `primaryLatest`, so the column that names the list's purpose was
     * the one column the scan walked straight past.
     */
    const NUMERIC_COLUMNS = ["ping", "jitter", "download", "upload", "time",
        "serverId", "packetLoss", "downloadLatency", "uploadLatency"];

    // Wide enough to hold "measured(downloadLatencyGauge, ", the longest way a
    // column legitimately reaches a gauge.
    const PREFIX_CHARS = 40;

    // Sliced from ahead of the match rather than captured by a leading
    // `(.{0,40})`, which is how the widening from the literal `latest` first
    // went wrong: a greedy prefix eats the row name and leaves `\w+` matching
    // its last letter, so every capture ended "lates" and nothing could match.
    const readsOf = (column) => [...collect.matchAll(new RegExp(`\\w+\\.${column}\\b`, "g"))]
        .map(({index}) => collect.slice(Math.max(0, index - PREFIX_CHARS), index));

    // A scan over a column nothing reads passes for the wrong reason, and this
    // list has already carried such a name. Every entry has to be reached.
    it("finds a read for every column it claims to check", () => {
        for (const column of NUMERIC_COLUMNS)
            assert.ok(readsOf(column).length > 0,
                `nothing in the scrape reads ${column}, so the check on it asserts nothing`);
    });

    it("reads every numeric column through one of the shared readers", () => {
        // Either the reader named at the call site, or the shared helper -
        // whose own reading is pinned by the test below, since naming it here
        // would accept `measured(pingGauge, latest.ping)` written over a
        // helper that had stopped reading anything.
        const guarded = new RegExp(`(?:${SHARED_READERS.join("|")})\\($|measured\\(\\w+, $`);

        for (const column of NUMERIC_COLUMNS)
            for (const before of readsOf(column))
                assert.ok(guarded.test(before),
                    `${column} reaches a gauge through a reading of the route's own`);
    });

    /*
     * And the helper the scan above accepts on trust, which is the one place
     * six of the seven gauges are set from. Without this, dropping the reader
     * from inside it publishes every raw column at once - and prom-client
     * throws for anything that is not a number, so that is the whole scrape.
     *
     * The reader is a parameter with a default, as statistics.js's mapRange
     * takes one and for the same reason: a column added here without a reader
     * of its own must land on the strict answer, not the permissive one.
     */
    it("reads the value inside the helper the measurements share", () => {
        const [, fallback] = collect.match(/const measured = \([^)]*\bread = (\w+)\)/) ?? [];

        assert.ok(SHARED_READERS.includes(fallback),
            "the shared gauge setter's default reader is not one of the shared ones");

        const helper = bodyOf(source, "const measured = (");

        assert.match(helper, /\bread\(/, "the shared gauge setter no longer reads what it is given");
        assert.doesNotMatch(helper, /\.set\(\s*labels\s*,\s*value\s*\)/,
            "the shared gauge setter hands the raw column to a gauge");
    });

    it("still reports the failure placeholder rather than dropping the scrape", () => {
        assert.match(collect, /testFailedGauge\.set\(labels, 1\)/,
            "a failed test no longer reports as failed");
    });

    /*
     * setSeries, run.
     *
     * The gauges, the label resolver and the readers are all handed in, so the
     * body executes without a registry, a database or a response - the three
     * things that keep collect() itself to a scan. What comes back is the set
     * of series the scrape would publish for one row, by gauge name: a name
     * that is absent is a series left unset, which is a genuine gap rather
     * than a stale value, because collect() clears every gauge before it
     * decides anything and prom-client's reset() empties a labelled gauge's
     * whole hashMap.
     */
    const GAUGES = ["serverInfoGauge", "timeGauge", "testFailedGauge", "pingGauge", "jitterGauge",
        "downloadGauge", "uploadGauge", "packetLossGauge", "downloadLatencyGauge", "uploadLatencyGauge"];

    const publishedFor = (latest) => {
        const published = {};
        const stubs = GAUGES.map((name) => ({set: (labels, value) => { published[name] = value; }}));

        new Function("latest", "targetLabels", "resolveServerLabels", "isFailedTest",
            "metricValue", "usableFigure", "measuredPing", ...GAUGES, setSeriesBody)(
            latest, {}, () => ({server_id: "1", server_name: "", server_host: ""}), isFailedTest,
            metricValue, usableFigure, measuredPing, ...stubs);

        return published;
    };

    const ROW = {
        ping: 12.4, jitter: 1.2, download: 480.2, upload: 96.1, time: 8,
        packetLoss: 0, downloadLatency: 231.4, uploadLatency: 88.1, serverId: 1, error: null
    };

    it("publishes an ordinary row in full", () => {
        const published = publishedFor(ROW);

        assert.equal(published.pingGauge, 12.4);
        assert.equal(published.downloadGauge, 480.2);
        assert.equal(published.uploadGauge, 96.1);
        assert.equal(published.jitterGauge, 1.2);
        assert.equal(published.testFailedGauge, 0);
        assert.equal(published.packetLossGauge, 0, "a line that lost no packets is a reading, not an absence");
    });

    /**
     * The fabricated latency, which is what this route published as a perfect
     * 0 ms line.
     *
     * Two parsers write it: parseCloudflare answers `round(avg_latency_ms) ?? 0`
     * for a run whose latency block carried no average, and parseIperf3 does
     * the same - a dual-stack endpoint measured over a pinned IPv4 interface
     * stores it for the life of the target. The statistics have drawn a gap
     * there since UNMEASURED_LATENCY was written and the alert gate has refused
     * it for longer; Grafana was shown a flat, perfect line for the same row.
     */
    it("leaves the ping series unset for a latency nobody measured", () => {
        const published = publishedFor({...ROW, ping: 0});

        assert.ok(!Object.hasOwn(published, "pingGauge"),
            "a fabricated 0 ms was published as a reading");
        assert.equal(published.downloadGauge, 480.2, "the rest of a good row went with it");
        assert.equal(published.testFailedGauge, 0, "the row is a success and still reports as one");
    });

    // And the reading the comparison has to stay exact for: the column has held
    // decimals since migration 0010, so a genuine sub-millisecond line arrives
    // as the fraction it measured and must survive.
    it("publishes a real sub-millisecond latency", () => {
        assert.equal(publishedFor({...ROW, ping: 0.24}).pingGauge, 0.24);
    });

    /**
     * A lone placeholder on a row that succeeded.
     *
     * isFailedTest asks whether all three required columns are -1, so
     * {ping: -1, download: 480.2, upload: -1} is a success by that rule and
     * always was - the shape a hand-edited import produces. Read through bare
     * metricValue, which keeps -1 for its caller to judge, this route then
     * shipped myspeed_upload -1: a line delivering minus one megabit, recorded
     * beside myspeed_test_failed 0. fullSeries reads the same columns through
     * usableFigure and draws the gap.
     */
    it("leaves out a placeholder measurement on an otherwise successful row", () => {
        const published = publishedFor({...ROW, ping: -1, upload: -1});

        assert.equal(published.testFailedGauge, 0, "one real reading is enough to keep the row");
        assert.equal(published.downloadGauge, 480.2);
        assert.ok(!Object.hasOwn(published, "uploadGauge"), "myspeed_upload published minus one megabit");
        assert.ok(!Object.hasOwn(published, "pingGauge"), "myspeed_ping published minus one millisecond");
    });

    // The optional columns keep the answer they already had, through the reader
    // they now share with the required ones.
    it("leaves out an optional figure the provider did not report", () => {
        const published = publishedFor({...ROW, jitter: null, packetLoss: null,
            downloadLatency: null, uploadLatency: null});

        for (const gauge of ["jitterGauge", "packetLossGauge", "downloadLatencyGauge", "uploadLatencyGauge"])
            assert.ok(!Object.hasOwn(published, gauge), `${gauge} claimed a figure nobody measured`);
    });

    it("reports a failed row as failed and publishes none of its placeholders", () => {
        const published = publishedFor({...ROW, ping: -1, download: -1, upload: -1, time: -1});

        assert.equal(published.testFailedGauge, 1);
        for (const gauge of ["pingGauge", "downloadGauge", "uploadGauge", "timeGauge"])
            assert.ok(!Object.hasOwn(published, gauge), `${gauge} published a failed run's placeholder`);
    });
});

/**
 * The other half of the same widening, which was left behind.
 *
 * metricValue was taught to read a numeric string because that is what an
 * imported history holds - and isFailedTest, the partner that decides whether
 * those numbers are measurements at all, still compared with === against the
 * number -1. So exactly the rows the widening admitted walked past the
 * failed-test branch: the scrape published myspeed_test_failed 0 and then
 * myspeed_ping -1 beside it, a line delivering minus one megabit recorded as a
 * healthy sample. Before the widening that scrape 500'd, which was wrong but
 * was at least visibly wrong.
 *
 * The predicate reads its columns the same way the gauges do. Every other
 * reader of a stored row gains the same answer, which is the point: the client,
 * the status route and the statistics all judge these rows too.
 */
describe("a failure imported as text", () => {
    const asText = {ping: "-1", download: "-1", upload: "-1", error: null};

    it("is still a failure", () => {
        assert.equal(isFailedTest(asText), true,
            "an imported failure reports its placeholders as measurements");
        assert.equal(isSuccessfulTest(asText), false);
    });

    it("does not make a success out of a mixed row", () => {
        // One real reading is enough to keep the row, exactly as it is for a
        // row stored as numbers - the widening must not change that judgement,
        // only the spelling it accepts.
        assert.equal(isFailedTest({...asText, download: "480.2"}), false);
        assert.equal(isFailedTest({ping: -1, download: 480.2, upload: -1, error: null}), false);
    });

    it("leaves a row it cannot read alone", () => {
        // "auto" is not -1 and not a measurement either; nothing here should
        // promote an unreadable column into a placeholder.
        assert.equal(isFailedTest({ping: "auto", download: "auto", upload: "auto", error: null}), false);
        assert.equal(isFailedTest({ping: "", download: "", upload: "", error: null}), false);
    });
});

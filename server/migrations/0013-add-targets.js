import { DataTypes } from 'sequelize';
import { ALLOWED_PROTOCOLS } from '../util/safeUrl.js';

/**
 * Targets: named provider+server pairings tested each scheduled round.
 *
 * The instance used to hold exactly one choice, spread over four config keys
 * (provider, ooklaId, libreId, libreUrl). That shape cannot say "the Frankfurt
 * Ookla server AND my own LibreSpeed AND the NAS over iperf3", which is what
 * upstream keeps asking for (#945, #848, #922). A target row is one such
 * pairing; the round runs every enabled one in sortOrder.
 *
 * The four legacy keys are folded into a seeded first target and then deleted
 * from the config table - nothing reads them afterwards, and leaving them
 * would let an old export resurrect a parallel truth beside the table.
 */

const PROVIDERS = ['ookla', 'libre', 'cloudflare'];

/**
 * The single target the legacy keys describe, or null when they never chose
 * a provider. Pure, so the fold from four keys to one row can be tested
 * without a database on either side.
 *
 * @param values the config table as {key: value}
 */
export const legacyTarget = (values) => {
    const provider = values.provider;

    if (!PROVIDERS.includes(provider)) return null;

    const serverId = values[`${provider}Id`];
    const endpoint = provider === 'libre' ? values.libreUrl : undefined;

    return {
        // The provider's display name is the obvious first label; the
        // operator renames it in the dialog.
        name: {ookla: 'Ookla', libre: 'LibreSpeed', cloudflare: 'Cloudflare'}[provider],
        provider,
        serverId: serverId && serverId !== 'none' ? serverId : null,
        endpoint: endpoint && endpoint !== 'none' ? endpoint : null,
        enabled: true,
        alerts: true,
        sortOrder: 0,
        created: new Date().toISOString()
    };
};

/** Whether an address is one this server could actually fetch a backend from. */
const fetchable = (endpoint) => {
    try {
        return ALLOWED_PROTOCOLS.has(new URL(endpoint).protocol);
    } catch {
        return false;
    }
};

// What a server id has to look like to be written to a target row. A copy of
// targetProblem's rule rather than an import of it - see seedTarget - and the
// same one validateInput held the legacy keys to, so this normalises only
// values that predate that check or were edited into the table by hand.
const SERVER_ID_DIGITS = /^\d+$/;

/**
 * The row the migration writes: the legacy fold, made acceptable to the
 * validator that will judge it on every later edit.
 *
 * Separate from legacyTarget because the fold has a second caller with its own
 * rules - importConfig folds the same four keys out of an old backup - and
 * because only the write has to answer to targetProblem.
 *
 * It has to answer to it because a PATCH is judged as the row it would become,
 * not as the fragment that arrived (routes/targets.js re-judges the merged
 * row). Older versions validated the librespeed backend URL with a bare
 * `new URL(value)`, which parses "localhost:8080" quite happily as scheme
 * "localhost:" - so instances upgrading from 1.3.5 and earlier carry stored
 * addresses that were accepted behind a 200 and that the CLI could never
 * fetch. Folded verbatim, such a value becomes a target the operator can
 * neither run nor edit: flipping its scheduled switch in the dialog sends
 * {enabled} alone and comes back 400 "The endpoint's protocol is not allowed",
 * about a field the request never sent, for a row the server itself wrote.
 * Dropping the endpoint is the trade importConfig already takes for the same
 * value - "choose a server automatically" - and it loses nothing, because the
 * speedtest was failing on that address anyway.
 *
 * Graced unconditionally, never refused: whatever comes back from here gets
 * inserted, because a seed withheld would take the history's back-fill with it
 * and leave the instance with no target and years of unattributable rows -
 * worse than the row this exists to prevent.
 *
 * The rules are inlined rather than taken from controller/targets.js on
 * purpose. That module reaches the provider registry and the models, which a
 * migration running before the app is up has no business loading, and what an
 * upgrade did must stay fixed in this file rather than shift with a later
 * tightening of a live validator. The protocol set is the exception, imported
 * because it is the codebase's one home for "can this be fetched" and because
 * a row written here must satisfy whichever answer that set gives. Pure and
 * exported so the agreement can be tested from both ends.
 *
 * @param values the config table as {key: value}
 */
export const seedTarget = (values) => {
    const seed = legacyTarget(values);

    if (seed === null) return null;

    if (seed.endpoint !== null && !fetchable(seed.endpoint)) seed.endpoint = null;
    if (seed.serverId !== null && !SERVER_ID_DIGITS.test(seed.serverId)) seed.serverId = null;

    return seed;
};

const TARGETS_SCHEMA = {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    provider: { type: DataTypes.STRING, allowNull: false },
    serverId: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
    endpoint: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    alerts: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    optimalPing: { type: DataTypes.DOUBLE, allowNull: true, defaultValue: null },
    optimalDownload: { type: DataTypes.DOUBLE, allowNull: true, defaultValue: null },
    optimalUpload: { type: DataTypes.DOUBLE, allowNull: true, defaultValue: null },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created: {
        type: process.env.DB_TYPE === 'mysql' ? DataTypes.STRING : DataTypes.TIME,
        defaultValue: DataTypes.NOW
    }
};

const LEGACY_KEYS = ['provider', 'ooklaId', 'libreId', 'libreUrl'];

/**
 * How many historical rows one back-fill statement rewrites.
 *
 * As a single statement the back-fill rewrote the whole table, which is
 * exactly what a MySQL lock-wait timeout, an OOM, or an MSI service stop
 * interrupts - and a statement-level rollback leaves every row still NULL, so
 * the retry issued the identical statement and died the identical death: a
 * boot loop, ended only by hand. Chunked, each statement commits on its own,
 * so every boot keeps the chunks it managed and the retry starts where the
 * last attempt stopped.
 */
export const BACKFILL_CHUNK_ROWS = 5000;

export const TARGET_INDEX_NAME = 'speedtests_target_created';

/**
 * The index every per-target read leans on: the Prometheus scrape's
 * latest-row-per-target, the ?target= filters on the list, the statistics and
 * the export, and the back-fill's own is-anything-left probe. Without it each
 * of those walks the created index (or the whole table) looking for a
 * targetId it has no way to seek. Guarded, because 0014 adds the same index
 * to instances that upgraded before this migration learned to.
 */
export const ensureTargetIndex = async (queryInterface) => {
    const indexes = await queryInterface.showIndex('speedtests');
    if (indexes.some((index) => index.name === TARGET_INDEX_NAME)) return;

    await queryInterface.addIndex('speedtests', ['targetId', 'created'], {name: TARGET_INDEX_NAME});
};

export async function up(queryInterface) {
    const existing = new Set(await queryInterface.showAllTables());

    if (!existing.has('targets')) await queryInterface.createTable('targets', TARGETS_SCHEMA);

    const tests = await queryInterface.describeTable('speedtests');

    if (!tests.targetId)
        await queryInterface.addColumn('speedtests', 'targetId', {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null
        });

    // Ahead of the back-fill, so the chunk walk below seeks instead of
    // scanning - the statement each interrupted boot retries gets cheaper,
    // not merely smaller.
    await ensureTargetIndex(queryInterface);

    const [rows] = await queryInterface.sequelize.query(
        'SELECT `key`, `value` FROM `config`', {raw: true});
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

    // Idempotence used to ride on the legacy keys: the seed deleted them, so a
    // second run found no provider and folded nothing. But that delete is the
    // last statement in this function and nothing here is transactional (see
    // migrationRunner for why it cannot usefully be), so a run that inserted
    // the seed and then died left the keys in place with 0013 still unrecorded.
    // The realistic way to die is the UPDATE below - it rewrites every
    // historical row, which is what a MySQL lock-wait timeout, an OOM, or an
    // MSI service stop during the upgrade interrupts. The operator restarts,
    // the migration re-runs, and the instance comes up with two identical
    // enabled targets: roundTargets() returns both, so every scheduled round
    // measures the same server twice, hourly, with two notifications for it.
    //
    // So the guard is the table the seed lands in, not the keys it deletes
    // last. Nothing else creates or writes `targets` before 0013 is recorded -
    // no other migration touches it and the API is not up yet - so a row here
    // can only be a seed a previous attempt already wrote.
    const [[{seeded}]] = await queryInterface.sequelize.query(
        'SELECT COUNT(*) AS seeded FROM `targets`', {raw: true});

    if (Number(seeded) === 0) {
        const seed = seedTarget(values);

        if (seed) await queryInterface.bulkInsert('targets', [seed]);
    }

    // The back-fill sits outside that guard on purpose. The history so far was
    // measured against exactly this configuration, so it belongs to the seeded
    // target: filtering by it after the upgrade must show the years of rows
    // recorded before it had a name. Gating it on having just inserted would
    // strand precisely the instance the guard above exists for - the one whose
    // first attempt died in this UPDATE - because its retry finds the seed
    // already there, skips the insert, and would then record 0013 with the
    // history unattributed for good. Repeating the UPDATE instead costs
    // nothing: `targetId IS NULL` matches no row the second time round.
    //
    // The earliest id is the seed's on both paths, because the guard allows at
    // most one row; an instance that never chose a provider has none, and its
    // history has no target to belong to.
    const [[seedRow]] = await queryInterface.sequelize.query(
        'SELECT `id` FROM `targets` ORDER BY `id` LIMIT 1', {raw: true});

    /*
     * One chunk per statement, looping until the probe finds nothing left.
     *
     * The inner select is wrapped in a derived table because MySQL refuses to
     * update a table it is selecting from in the same statement (ER 1093);
     * sqlite reads the wrapped form just as happily. Ordered by id so the
     * chunks are deterministic, and each statement auto-commits - which is the
     * whole point: an interrupted upgrade resumes instead of starting over.
     */
    if (seedRow) {
        let remaining = true;

        while (remaining) {
            await queryInterface.sequelize.query(
                'UPDATE `speedtests` SET `targetId` = ? WHERE `id` IN ('
                + 'SELECT `id` FROM (SELECT `id` FROM `speedtests` WHERE `targetId` IS NULL '
                + 'ORDER BY `id` LIMIT ?) AS `chunk`)',
                {replacements: [seedRow.id, BACKFILL_CHUNK_ROWS]});

            const [leftovers] = await queryInterface.sequelize.query(
                'SELECT `id` FROM `speedtests` WHERE `targetId` IS NULL LIMIT 1', {raw: true});

            remaining = leftovers.length > 0;
        }
    }

    await queryInterface.bulkDelete('config', {key: LEGACY_KEYS});
}

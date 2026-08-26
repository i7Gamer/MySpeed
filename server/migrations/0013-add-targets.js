import { DataTypes } from 'sequelize';

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

    // Idempotence rides on the legacy keys: the seed deletes them, so a
    // second run finds no provider row and folds nothing.
    const [rows] = await queryInterface.sequelize.query(
        'SELECT `key`, `value` FROM `config`', {raw: true});
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

    const seed = legacyTarget(values);

    if (seed) {
        await queryInterface.bulkInsert('targets', [seed]);

        // The history so far was measured against exactly this configuration,
        // so it belongs to the seeded target: filtering by it after the
        // upgrade must show the years of rows recorded before it had a name.
        // The seed is the only row in a table this migration just created.
        const [[row]] = await queryInterface.sequelize.query(
            'SELECT `id` FROM `targets` ORDER BY `id` LIMIT 1', {raw: true});

        await queryInterface.sequelize.query(
            'UPDATE `speedtests` SET `targetId` = ? WHERE `targetId` IS NULL',
            {replacements: [row.id]});
    }

    await queryInterface.bulkDelete('config', {key: LEGACY_KEYS});
}

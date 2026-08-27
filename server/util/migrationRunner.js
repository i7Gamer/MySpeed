import { DataTypes, QueryTypes } from 'sequelize';
import db from '../config/database.js';
import migrations from '../migrations/index.js';

const META_TABLE = 'SequelizeMeta';

const ensureMetaTable = async (queryInterface) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes(META_TABLE)) return;

    await queryInterface.createTable(META_TABLE, {
        name: { type: DataTypes.STRING, allowNull: false, primaryKey: true }
    });
    console.log(`Created ${META_TABLE} table for tracking migrations`);
};

const getExecutedMigrations = async () => {
    const rows = await db.query(`SELECT name FROM ${META_TABLE} ORDER BY name ASC`,
        { type: QueryTypes.SELECT });
    return new Set(rows.map(row => row.name));
};

export const runMigrations = async () => {
    const queryInterface = db.getQueryInterface();
    await ensureMetaTable(queryInterface);

    const executed = await getExecutedMigrations();
    const pending = migrations.filter(m => !executed.has(m.name));

    if (pending.length === 0) {
        console.log('No pending migrations found');
        return;
    }

    console.log(`Found ${pending.length} pending migration(s)`);

    for (const { name, up } of pending) {
        console.log(`Running migration: ${name}`);

        /*
         * Deliberately not wrapped in a transaction, which means every up()
         * has to be safe to run twice - 0013's seed guard is what that costs.
         *
         * A transaction opened around this call would not buy what it looks
         * like it buys. Sequelize has no ambient transaction in this project -
         * nothing calls useCLS in config/database.js - so the handle would be
         * joined by nothing inside up(): every queryInterface call and every
         * raw query would still commit on its own unless all thirteen
         * migrations were rewritten to thread it through. And even then, MySQL
         * commits implicitly on DDL, which is most of what these migrations
         * are - createTable and addColumn in 0013 alone - so the rollback would
         * silently cover only a migration's tail on the backend whose lock
         * timeouts are the likeliest reason to want one at all.
         *
         * The guarantee is idempotence per migration instead: the name is
         * recorded only after up() returns, so a migration that dies partway is
         * re-run whole on the next boot and must tolerate that.
         */
        try {
            await up(queryInterface, DataTypes);
            await db.query(`INSERT INTO ${META_TABLE} (name) VALUES (?)`, { replacements: [name] });
            console.log(`Migration ${name} completed successfully`);
        } catch (error) {
            console.error(`Migration ${name} failed:`, error.message);
            throw error;
        }
    }

    console.log('All migrations completed successfully');
};

export default runMigrations;

import { Sequelize } from 'sequelize';
import sqlite3Shim from '../util/bun-sqlite-shim.js';

/**
 * Where the sqlite database lives, relative to the working directory the
 * process was started in.
 *
 * Exported because it was copied instead: getUsedStorage rebuilt the same
 * filename from process.cwd() to stat it, so the file the size dialog reported
 * on and the file sequelize actually opened were two independent derivations
 * that happened to agree. A divergence would not raise - fileBytes swallows
 * ENOENT and answers 0 - so moving the database, for a data-directory setting
 * or a different installer layout, would silently report an empty one.
 */
export const SQLITE_STORAGE_PATH =
    `data/storage${process.env.PREVIEW_MODE === "true" ? "_preview" : ""}.db`;

/**
 * DATE columns are stored as ISO-8601 UTC strings rather than in whatever
 * local form the dialect would pick.
 *
 * The argument matters: this used to take none at all, so every DATE written
 * was substituted with the moment of the write. Sequelize's sqlite DATE
 * subclass overrides only `parse` and inherits this, which made
 * integration_data.lastActivity the one column it reached - restoring a backup
 * brought every integration back reporting "last run: a few seconds ago",
 * whatever the file said. MySQL was unaffected: its subclass defines its own.
 *
 * A value that is not a date at all still falls back to now, which is what the
 * column meant before and is better than writing an invalid string.
 *
 * Absent is not the same as unparseable, and the fallback cannot tell them
 * apart on its own: `new Date(null)` is the epoch - a valid time, so it walks
 * past the isNaN guard and renders 1970-01-01 - while `new Date(undefined)` is
 * caught by it and renders the moment of the write. Neither is what a nullable
 * column such as integration_data.lastActivity means by "has never run".
 *
 * This guard is defensive rather than a fix for an observed corruption:
 * sequelize 6 does not route a null through _stringify on either dialect it is
 * given here - it writes SQL NULL directly - so no ORM path reaches the
 * fallback today. What it costs is one comparison, and what it buys is that the
 * function is correct in isolation, which is the only thing its callers can
 * rely on if that ever changes.
 */
Sequelize.DATE.prototype._stringify = (date) => {
    if (date === null || date === undefined) return date;

    const value = new Date(date);

    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

let db;

if (process.env.DB_TYPE === "mysql") {

    if (!process.env.DB_NAME || !process.env.DB_PASS || !process.env.DB_USER)
        throw new Error("Missing database environment variables");

    db = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
        host: process.env.DB_HOST || "localhost",
        dialect: 'mysql',
        logging: false,
        query: {raw: true}
    });
} else if (!process.env.DB_TYPE || process.env.DB_TYPE === "sqlite") {
    db = new Sequelize({
        dialect: 'sqlite',
        dialectModule: sqlite3Shim,
        storage: SQLITE_STORAGE_PATH,
        logging: false,
        query: {raw: true}
    });
} else {
    throw new Error("Invalid database type");
}

export default db;
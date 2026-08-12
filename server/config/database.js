import { Sequelize } from 'sequelize';
import sqlite3Shim from '../util/bun-sqlite-shim.js';

const STORAGE_PATH = `data/storage${process.env.PREVIEW_MODE === "true" ? "_preview" : ""}.db`;

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
 * Absent is not the same as unparseable, though, and this used to treat it as
 * such. `new Date(null)` is the epoch - a valid time, so it walked straight
 * past the isNaN guard and wrote 1970-01-01 - while `new Date(undefined)` hit
 * the guard and wrote the moment of the write. integration_data.lastActivity is
 * nullable and means "has never run", so a fresh integration came back claiming
 * it had just run and a cleared one came back having last run in 1970. A column
 * with no value keeps having no value.
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
        storage: STORAGE_PATH,
        logging: false,
        query: {raw: true}
    });
} else {
    throw new Error("Invalid database type");
}

export default db;
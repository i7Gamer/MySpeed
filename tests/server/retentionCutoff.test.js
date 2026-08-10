import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { retentionCutoffFilter } from "../../server/controller/speedtests.js";

/**
 * The where clause the retention sweep deletes with.
 *
 * Every write stores `created` as an ISO-8601 UTC string on both dialects -
 * the model maps the column to STRING on mysql - so the cutoff has to be the
 * same kind of string everywhere. The mysql branch passed a Date instead,
 * which the dialect renders as "2025-08-10 12:00:00": a space where the stored
 * value has a 'T', and since ' ' sorts below 'T', every row from the cutoff
 * day compared as newer and survived - the very bug the sqlite branch had
 * already been fixed for.
 */
const originalDbType = process.env.DB_TYPE;

afterEach(() => {
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
});

describe("retentionCutoffFilter", () => {
    const cutoff = new Date("2025-08-10T12:00:00.000Z");

    for (const dialect of [undefined, "sqlite", "mysql"]) {
        it(`compares the stored ISO string on ${dialect ?? "the default dialect"}`, () => {
            if (dialect === undefined) delete process.env.DB_TYPE;
            else process.env.DB_TYPE = dialect;

            const filter = retentionCutoffFilter(cutoff);

            assert.equal(filter[Op.lte], "2025-08-10T12:00:00.000Z",
                "the cutoff must be the ISO string the rows are stored as");
        });
    }
});

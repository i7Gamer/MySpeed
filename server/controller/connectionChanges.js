import { Op } from 'sequelize';
import model from '../models/ConnectionChanges.js';
import tests from '../models/Speedtests.js';
import { IPV6, addressFamily, describeChange, normalisedIsp } from '../util/connectionChange.js';
import { toErrorMessage } from '../util/helpers.js';

/**
 * The log of runs that saw the external address or the provider change.
 *
 * Judged from the tests themselves rather than from a "current identity"
 * kept beside the log: the previous run is the honest yardstick, it is
 * already stored, and a log that seeds itself needs no first observation
 * to be written by hand on an upgrade.
 */

/** How many changes the log keeps. Bounded whatever the line does: an hourly CGNAT flap fills this in three weeks and then rolls. */
export const CHANGE_LOG_LIMIT = 500;

/** How many the route hands out - the newest, which are the ones anyone reads. */
export const MAX_LISTED = 100;

/**
 * How far back the previous address is looked for. A floor rather than
 * the whole table: the first IPv6 run on a history that never had one
 * would otherwise walk every row there is, once per test, to find nothing.
 */
export const LOOKBACK_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const NEWEST_FIRST = [["created", "DESC"], ["id", "DESC"]];

const IPV6_SHAPE = "%:%";

/**
 * The connection seen before this run, by the same target: the newest
 * earlier address of the same family, and the newest earlier name the same
 * provider gave. The target's own runs only, because two targets pinned to
 * two WAN links would otherwise find each other's address as "the previous
 * one" and log a change on every alternation; the name by the same provider
 * too, because providers spell a network their own way and a target whose
 * provider was edited would compare two spellings of one network. A run from before
 * targets existed carries no target and is compared with nothing.
 *
 * Strictly earlier by instant, which excludes the run itself and any
 * imported row stamped later. The window is closed at the lookback below.
 */
export const previousIdentity = async ({id, created, externalIp, provider, targetId = null}) => {
    const floor = new Date(new Date(created).getTime() - LOOKBACK_DAYS * MS_PER_DAY).toISOString();
    const earlier = {created: {[Op.lt]: created, [Op.gte]: floor}, id: {[Op.ne]: id}, targetId};

    const family = addressFamily(externalIp);
    // `:` is no wildcard on either dialect, and an IPv4 address never holds
    // one. NOT LIKE is false rather than true for NULL, so the null guard is
    // spelled out.
    const sameFamily = family === 0 ? null : await tests.findOne({
        attributes: ["externalIp"], raw: true, order: NEWEST_FIRST,
        where: {...earlier, externalIp: {[Op.not]: null, [family === IPV6 ? Op.like : Op.notLike]: IPV6_SHAPE}}
    });

    const sameProvider = await tests.findOne({
        attributes: ["isp"], raw: true, order: NEWEST_FIRST,
        where: {...earlier, provider, isp: {[Op.not]: null}}
    });

    return {externalIp: sameFamily?.externalIp ?? null, isp: sameProvider?.isp ?? null};
};

/** The oldest rows past the limit, gone. */
const trim = async () => {
    const excess = await model.findAll({
        attributes: ["id"], raw: true, order: NEWEST_FIRST, offset: CHANGE_LOG_LIMIT, limit: CHANGE_LOG_LIMIT
    });

    if (excess.length > 0) await model.destroy({where: {id: {[Op.in]: excess.map((row) => row.id)}}});
};

/**
 * Judges the run just written against the connection seen before it and
 * keeps the verdict. Answers the row written, or null for no change - and
 * null, said in the log, when the database refuses: a log that cannot be
 * written must not fail the test it follows.
 *
 * @param test    {id, created, isp, externalIp, provider} of the row just written
 * @param target  the member that ran it; its id travels on the row
 */
export const recordChange = async (test, target) => {
    try {
        if (addressFamily(test.externalIp) === 0 && normalisedIsp(test.isp) === null) return null;
        // A run from before targets existed has nothing of its own to be
        // compared with.
        if (target?.id == null) return null;

        const change = describeChange(test, await previousIdentity({...test, targetId: target.id}));
        if (change === null) return null;

        const row = await model.create({
            created: test.created, testId: test.id, targetId: target.id, provider: test.provider, ...change
        });
        await trim();

        return row.get({plain: true});
    } catch (error) {
        console.error(`Could not record the connection change: ${toErrorMessage(error)}`);
        return null;
    }
};

/** The newest changes, newest first. */
export const listChanges = async (limit = MAX_LISTED) =>
    await model.findAll({raw: true, order: NEWEST_FIRST, limit});

/** Gone with the history - see the model's header. */
export const removeAll = async () => {
    await model.destroy({where: {}});
};

/**
 * Gone with the tests the retention sweep forgets. The same comparison the
 * sweep uses on the tests, on every dialect: the stored instant is an ISO
 * string, and so is the cutoff.
 */
export const removeOlderThan = async (cutoff) => {
    await model.destroy({where: {created: {[Op.lte]: cutoff.toISOString()}}});
};

import recommendations from '../models/Recommendations.js';
import { triggerEvent } from './integrations.js';
import { toErrorMessage } from '../util/helpers.js';
import { createQueue } from '../util/serialiseQueue.js';

// The one recommendations row, read deterministically. The table is a
// singleton, but importConfig restores it wholesale and bounds it only by a
// row cap - so a backup can leave more than one, and an unordered findOne is
// then free to answer either. getCurrent and update() both read through this,
// so the row the card shows and the row the round refreshes are always the
// same one.
const currentRow = (extra = {}) => recommendations.findOne({order: [["id", "ASC"]], ...extra});

export const getCurrent = async () => {
    return await currentRow();
}

const applyUpdate = async (ping, download, upload) => {
    // Two decimals, the same as the speeds beside it. Math.round() here threw
    // away the fraction that is most of a latency reading on a fast line, and
    // took anything under half a millisecond down to 0 - a figure no later test
    // can beat, so the recommendation it poisoned was permanent.
    const configuration = {ping: parseFloat(ping.toFixed(2)), download: parseFloat(download.toFixed(2)),
        upload: parseFloat(upload.toFixed(2))};
    
    const existing = await currentRow();

    // Announced after the write, not before it. Fired first, a database that
    // then refused the write had already told every webhook the recommendations
    // had changed - and told them the figures it was about to fail to store.
    //
    // Still not awaited: an integration is allowed to be slow, and this runs on
    // the tail of a speedtest that has already finished. triggerEvent handles
    // its own failures per module.
    //
    // Caught, though. `then(() => {})` handles nothing - the promise it returns
    // carries the rejection on, and nothing was holding it. triggerEvent reads
    // the integration rows before it dispatches and that read is outside its
    // per-module try, so a locked sqlite file or a dropped connection rejected
    // into the process-level unhandledRejection hook and was logged as a bare
    // server fault naming nothing. This is the handler config.js:updateValue
    // grew for the same reason.
    const announce = () => triggerEvent("recommendationsUpdated", configuration)
        .catch((error) => console.error(
            `Could not announce the new recommendations: ${toErrorMessage(error)}`));

    if (existing) {
        await recommendations.update(configuration, {where: {id: existing.id}});
        announce();
        return currentRow({where: {id: existing.id}});
    }

    const created = await recommendations.create(configuration);
    announce();

    return created;
}

// One at a time. update() is fired once per round member, and the lookup above
// is a read followed by a write across an await: two members of one round
// finishing close together both found no row and both created one. The table
// has no key to refuse the second, and a transaction would not help - deferred
// on sqlite and repeatable-read on mysql, two readers both see nothing and
// both insert. The queue is what the prometheus scrape uses for the same
// read-then-write shape, and each caller still gets its own promise.
const writes = createQueue();

export const update = (ping, download, upload) => writes(() => applyUpdate(ping, download, upload));

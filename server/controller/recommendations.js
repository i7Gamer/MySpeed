import recommendations from '../models/Recommendations.js';
import { triggerEvent } from './integrations.js';
import { toErrorMessage } from '../util/helpers.js';

export const getCurrent = async () => {
    return await recommendations.findOne();
}

export const update = async (ping, download, upload) => {
    // Two decimals, the same as the speeds beside it. Math.round() here threw
    // away the fraction that is most of a latency reading on a fast line, and
    // took anything under half a millisecond down to 0 - a figure no later test
    // can beat, so the recommendation it poisoned was permanent.
    const configuration = {ping: parseFloat(ping.toFixed(2)), download: parseFloat(download.toFixed(2)),
        upload: parseFloat(upload.toFixed(2))};
    
    const existing = await recommendations.findOne();

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
        return recommendations.findOne({where: {id: existing.id}});
    }

    const created = await recommendations.create(configuration);
    announce();

    return created;
}
import recommendations from '../models/Recommendations.js';
import { triggerEvent } from './integrations.js';

export const getCurrent = async () => {
    return await recommendations.findOne();
}

export const update = async (ping, download, upload) => {
    const configuration = {ping: Math.round(ping), download: parseFloat(download.toFixed(2)),
        upload: parseFloat(upload.toFixed(2))};
    
    const existing = await recommendations.findOne();

    // Announced after the write, not before it. Fired first, a database that
    // then refused the write had already told every webhook the recommendations
    // had changed - and told them the figures it was about to fail to store.
    //
    // Still not awaited: an integration is allowed to be slow, and this runs on
    // the tail of a speedtest that has already finished. triggerEvent handles
    // its own failures per module.
    const announce = () => triggerEvent("recommendationsUpdated", configuration).then(() => {});

    if (existing) {
        await recommendations.update(configuration, {where: {id: existing.id}});
        announce();
        return recommendations.findOne({where: {id: existing.id}});
    }

    const created = await recommendations.create(configuration);
    announce();

    return created;
}
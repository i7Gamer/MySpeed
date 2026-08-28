import { ensureTargetIndex } from './0013-add-targets.js';

/**
 * The targetId index, for instances that upgraded before 0013 learned to
 * create it.
 *
 * 0013 now indexes (targetId, created) ahead of its back-fill, but a database
 * that already recorded 0013 never re-enters its up() - and without the index
 * every per-target read walks the created index or the whole table looking
 * for a targetId it cannot seek: the Prometheus scrape's latest-row-per-
 * target (one query per target, every scrape, in a serialised queue), the
 * ?target= filters on the list, the statistics and the export. The guard
 * lives in ensureTargetIndex, so the two migrations cannot disagree about
 * the index's name or shape.
 */
export async function up(queryInterface) {
    await ensureTargetIndex(queryInterface);
}

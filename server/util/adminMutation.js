import { createQueue } from './serialiseQueue.js';

/**
 * Single-process ownership of target/token mutations and config replacement.
 * Acquire at the public mutation boundary, before dependent reads or opening
 * a transaction. Transaction-internal helpers must never reacquire this queue.
 * External HTTP work must stay outside it.
 */
export const mutateAdminEntities = createQueue();

/**
 * Runs tasks one at a time, in the order they were handed over.
 *
 * For work that reads and writes something shared across an await, where two
 * callers interleaving would leave one of them looking at the other's
 * half-finished state. The prometheus scrape is the case this was written for:
 * the gauges are a module-level registry, and the scrape clears them, reads the
 * latest test, sets them and renders - so a second scrape entering at the wrong
 * point clears what the first is about to render, and that one serves an empty
 * exporter to whatever is watching.
 *
 * Each caller gets its own promise, and a task that throws rejects only that
 * one. The tail is deliberately the caught promise: keeping a rejected one
 * would reject everything queued behind a single failure without ever running
 * it, so one bad scrape would take out every scrape after it for the life of
 * the process.
 */
export const createQueue = () => {
    let tail = Promise.resolve();

    return (task) => {
        // Not tail.then(task, task): the tail never rejects, and a queue whose
        // failure handler is the task itself would run it twice if it ever did.
        const result = tail.then(task);

        tail = result.catch(() => undefined);

        return result;
    };
};

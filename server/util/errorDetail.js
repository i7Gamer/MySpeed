/**
 * What a thrown value says about itself once the parts an ORM keeps on the side
 * are put back.
 *
 * Upstream #1549 is a boot that opened the database, failed with "An error
 * occurred: Validation error", and did it 138 times. Those three words are the
 * whole of what sequelize volunteers for a ValidationError carrying no items:
 * the class of failure, the driver's code, the columns and the rule each one
 * broke all sit on properties of the error, and nothing here read them. So the
 * operator was told that something was invalid, given no way to find out what,
 * and deleted the database - which is the one action that loses the history the
 * instance exists to keep.
 *
 * This is the same fix importConfig got in 1.3.5, applied at the other end: a
 * refusal that names what it refused.
 *
 * What it deliberately never reports is the *value*. A validation error is as
 * likely to fire on the stored password hash, a node password or an integration
 * token as on a measurement, and what this produces is written to
 * data/logs/error.log - the file bug reports get attached to. 1.3.4 took
 * integration credentials out of that log and they are not going back in. The
 * column and the rule are enough to find the row by hand. For the same reason
 * `sql` and `parameters` on a DatabaseError are untouched: both carry the bound
 * values of the statement that failed.
 */

/**
 * Bounded because it is composed from a list that scales with the number of
 * columns, and this is a console line as well as a log entry.
 */
const MAX_DETAIL_LENGTH = 400;

/** The class name every ordinary Error carries, which says nothing. */
const PLAIN_ERROR_NAME = "Error";

/**
 * Whatever the value offers as its own message.
 *
 * Guarded the way errorHandler's asError is, and for the same reason: this is
 * reached from the uncaughtException path, so it is handed whatever was thrown -
 * including an object with no prototype, which cannot be coerced to a string at
 * all. A throw in here would end the process with neither the original error nor
 * this one written down.
 */
const baseMessage = (error) => {
    try {
        const message = error?.message;

        if (typeof message === "string" && message !== "") return message;

        return String(error);
    } catch {
        return "An error that could not be described";
    }
};

/** A string worth adding, or null. Anything else is not something to print. */
const usable = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * How one failed column is described: the rule it broke and the column it broke
 * it on.
 *
 * An item is whatever was in the array. Sequelize puts ValidationErrorItems
 * there, but the error can be constructed by anything - including our own code -
 * and a malformed one must not be the reason a report goes missing.
 */
const describeItem = (item) => {
    const path = usable(item?.path);
    const type = usable(item?.type) ?? usable(item?.validatorKey);

    if (path === null) return type;
    if (type === null) return path;

    return `${type} on ${path}`;
};

/**
 * The columns a unique constraint clashed on.
 *
 * Keys only - the values are the rows that clashed, which is exactly what must
 * not be logged. `fields` is an object on the errors sequelize builds and an
 * array on some driver paths, so both are read.
 */
const describeFields = (fields) => {
    if (fields === null || typeof fields !== "object") return null;

    const names = (Array.isArray(fields) ? fields : Object.keys(fields)).filter((name) => usable(name) !== null);

    return names.length === 0 ? null : `fields: ${names.join(", ")}`;
};

/**
 * The clauses worth adding to the message, in the order they are useful.
 *
 * Each one is dropped if the message already carries it. Several sequelize paths
 * build a detailed message themselves - a ValidationError handed no message
 * argument composes one from its items - and a UniqueConstraintError with a
 * parent adopts the driver's text wholesale, so the common case is that some of
 * this is already said. Saying it twice in one line is worse than not saying it.
 */
const detailClauses = (error, base) => {
    const clauses = [];
    const add = (clause) => {
        if (clause !== null && !base.includes(clause)) clauses.push(clause);
    };

    const name = usable(error?.name);
    if (name !== null && name !== PLAIN_ERROR_NAME) add(name);

    // The driver's code rather than its prose. `parent` and `original` are the
    // same object on every sequelize error that has one; both are read because
    // which of them is set has moved between versions.
    add(usable(error?.parent?.code ?? error?.original?.code ?? error?.code));

    const items = Array.isArray(error?.errors) ? error.errors : [];

    for (const item of items) {
        // Judged on the item's own message rather than on the clause built from
        // it, because the two are worded differently: sequelize composes
        // "notNull Violation: speedtests.ping cannot be null" and the clause is
        // "notNull Violation on ping", so a check for the clause finds nothing
        // and the rule is then named twice in one line. The item's message is
        // the exact text sequelize put in the base, so it is the thing to look
        // for.
        const already = usable(item?.message);

        if (already !== null && base.includes(already)) continue;

        add(describeItem(item));
    }

    // Only when there were no items. A unique-constraint error carries both, and
    // the items name the same columns these do.
    if (items.length === 0) add(describeFields(error?.fields));

    return clauses;
};

export const describeError = (error) => {
    const base = baseMessage(error);

    try {
        const clauses = detailClauses(error, base);

        if (clauses.length === 0) return base;

        const detail = clauses.join("; ");

        return `${base} (${detail.length > MAX_DETAIL_LENGTH
            ? detail.slice(0, MAX_DETAIL_LENGTH) + "…"
            : detail})`;
    } catch {
        // A property that throws when read - a getter on a hostile object, a
        // proxy - must cost the detail and not the report.
        return base;
    }
};

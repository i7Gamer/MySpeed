// The same ceilings the server's validateInput holds these to. A laxer copy
// here lets a value through unmarked that the save then bounces with nothing
// but a generic error state; a stricter one paints a red border on a value the
// server is perfectly happy with.
const TEXT_LIMIT = 250;
const TEXTAREA_LIMIT = 2000;

const isEmpty = (value) => value === undefined || value === null || value === "";

/**
 * Whether the card should mark this value as bad before trying to save it.
 *
 * Lifted out of IntegrationCard so it can be exercised without a renderer. It
 * mirrors the server deliberately - see tests/client/integrationLimits.test.js,
 * which scans both sources so the next change to either has to move both.
 */
export const isValidFieldValue = (field, value) => {
    if (field.required && isEmpty(value)) return false;
    if (isEmpty(value)) return true;

    if (field.regex && !new RegExp(field.regex).test(value)) return false;

    if (field.type === "text" && String(value).length > TEXT_LIMIT) return false;
    if (field.type === "textarea" && String(value).length > TEXTAREA_LIMIT) return false;

    if (field.type === "number") {
        const number = Number(value);

        // A field that declares `decimals` is compared against a stored
        // measurement rather than counted, so a fraction is legitimate for it.
        if (field.decimals ? !Number.isFinite(number) : !Number.isInteger(number)) return false;

        if (field.min !== undefined && number < field.min) return false;
        if (field.max !== undefined && number > field.max) return false;
    }

    return true;
};

/**
 * The body a card sends when it is saved.
 *
 * An emptied optional number is sent as an explicit null rather than left out.
 * The server merges only the keys it is given, so omitting one means "leave it
 * alone" - which for a number that was cleared means the old value survives the
 * save that was meant to remove it. For a threshold that silences an
 * integration, that is the difference between a setting and a trap: a mistyped
 * limit could only be undone by deleting the integration and building it again.
 *
 * A *required* number is still omitted when empty, because the server rejects
 * null on a required field outright - sending it would turn a half-filled form
 * into a flat error rather than a partial save.
 */
export const integrationPayload = (definition, fields, displayName) => {
    const payload = {};

    for (const field of definition.fields) {
        const value = fields[field.name];

        if (field.type === "number" && isEmpty(value)) {
            if (!field.required) payload[field.name] = null;
            continue;
        }

        payload[field.name] = value;
    }

    payload.integration_name = displayName;

    return payload;
};

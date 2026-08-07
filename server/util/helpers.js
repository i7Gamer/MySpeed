const pad = (n) => String(n).padStart(2, "0");

const getDateVariables = () => {
    const now = new Date();
    return {
        year: now.getFullYear(),
        month: pad(now.getMonth() + 1),
        day: pad(now.getDate()),
        hour: pad(now.getHours()),
        minute: pad(now.getMinutes()),
        second: pad(now.getSeconds())
    };
};

export const replaceVariables = (message, variables) => {
    const allVariables = {...getDateVariables(), ...variables};
    for (const variable in allVariables)
        message = message.replaceAll(`%${variable}%`, allVariables[variable]);
    return message;
};

const AVG_DECIMALS = 2;

const EMPTY_RANGE = {min: null, max: null, avg: null};

// Math.min(...[]) is Infinity and 0/0 is NaN, both of which JSON.stringify
// silently turns into null. Returning explicit nulls keeps the value honest for
// in-process consumers such as the Prometheus exporter.
const mapRange = (entries, type, averageOf) => {
    if (entries.length === 0) return {...EMPTY_RANGE};

    const values = entries.map((entry) => entry[type]);
    return {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: averageOf(values.reduce((a, b) => a + b, 0) / values.length)
    };
};

export const mapFixed = (entries, type) =>
    mapRange(entries, type, (avg) => parseFloat(avg.toFixed(AVG_DECIMALS)));

export const mapRounded = (entries, type) => mapRange(entries, type, Math.round);
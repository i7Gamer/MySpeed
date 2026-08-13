// `error` stays last: it is the only free-text column, so keeping it at the end
// means a reader scanning the numeric columns never has to step over it. New
// columns are inserted before it rather than appended.
export const CSV_COLUMNS = ["id", "ping", "jitter", "download", "upload", "time", "type", "created", "provider",
    "serverId", "serverName", "serverHost", "serverLocation", "packetLoss", "downloadLatency", "uploadLatency", "isp", "externalIp",
    "bytesDownloaded", "bytesUploaded", "resultId", "error"];

export const CSV_HEADER = `${CSV_COLUMNS.join(",")}\n`;

// A field opening with one of these is evaluated by a spreadsheet, and quoting
// it does not stop that, so it is defused with a leading apostrophe. `error`,
// `serverName`, `serverHost`, `serverLocation` and `isp` all carry text a
// remote provider chose.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

// Except when the whole field is just a number: every failed test stores -1 in
// ping, download and upload, and prefixing those handed Excel, Sheets and pandas
// three text columns where numbers belong. Anchored at both ends so `-1+1` or
// `-1;=cmd`, which only open like a number, keep the prefix. Sequelize returns a
// JS number and sqlite's dynamic typing sometimes the same value as a string, so
// the decision is made on the text rather than on the type.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

// RFC 4180: wrap every field in quotes and double any quote inside it. Quoting
// unconditionally means commas and newlines in free-text columns such as `error`
// or a server name can never shift the column layout of the row.
const cell = (value) => {
    if (value === null || value === undefined) return '""';
    const str = String(value);
    const sanitized = FORMULA_TRIGGER.test(str) && !PLAIN_NUMBER.test(str) ? `'${str}` : str;
    return `"${sanitized.replaceAll('"', '""')}"`;
};

export const toCsv = (entries) =>
    CSV_HEADER + entries.map(entry => CSV_COLUMNS.map(column => cell(entry[column])).join(",")).join("\n");

// `error` stays last: it is the only free-text column, so keeping it at the end
// means a reader scanning the numeric columns never has to step over it. New
// columns are inserted before it rather than appended.
export const CSV_COLUMNS = ["id", "ping", "jitter", "download", "upload", "time", "type", "created",
    "serverName", "serverHost", "packetLoss", "downloadLatency", "uploadLatency", "isp", "externalIp", "error"];

export const CSV_HEADER = `${CSV_COLUMNS.join(",")}\n`;

// RFC 4180: wrap every field in quotes and double any quote inside it. Quoting
// unconditionally means commas and newlines in free-text columns such as `error`
// or a server name can never shift the column layout of the row.
const cell = (value) => value === null || value === undefined
    ? '""'
    : `"${String(value).replaceAll('"', '""')}"`;

export const toCsv = (entries) =>
    CSV_HEADER + entries.map(entry => CSV_COLUMNS.map(column => cell(entry[column])).join(",")).join("\n");

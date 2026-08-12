import fs from 'node:fs';
import { getJson } from './http.js';
import { serverListFrom } from './serverList.js';

/**
 * These lists are fetched once at startup, off any request, and are a far
 * larger payload than a webhook body. Giving up on the deadline a webhook gets
 * cost the provider dialog its whole server list until the next restart - the
 * catch below only logs, nothing retries - so this one call is allowed to wait
 * a good deal longer than an integration ever may.
 */
const SERVER_LIST_TIMEOUT = 60000;

const sources = [
    {
        file: "data/servers/ookla.json",
        url: "https://www.speedtest.net/api/js/servers?limit=20",
        format: (row) => ({
            name: row.name,
            sponsor: row.sponsor,
            country: row.country,
            cc: row.cc,
            distance: row.distance,
            host: row.host
        }),
        isCurrent: (entries) => entries.length === 0 || entries.every(([, value]) =>
            value !== null && typeof value === "object" && "sponsor" in value && "name" in value)
    },
    {
        file: "data/servers/librespeed.json",
        url: "https://librespeed.org/backend-servers/servers.php",
        format: (row) => row.name,
        isCurrent: () => true
    }
];

const isFileCurrent = (file, isCurrent) => {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed === null || typeof parsed !== "object") return false;
        return isCurrent(Object.entries(parsed));
    } catch {
        return false;
    }
};

for (const {file, url, format, isCurrent} of sources) {
    if (fs.existsSync(file) && isFileCurrent(file, isCurrent)) continue;

    getJson(url, {timeout: SERVER_LIST_TIMEOUT})
        .then((data) => {
            const servers = serverListFrom(data, format);

            // Nothing written when the payload was not a list. It used to be
            // mapped over regardless, which threw on the error object a rate
            // limit answers 200 with, and the catch below then blamed the
            // network for it.
            if (servers === null)
                return console.error(`Could not load servers from ${url}: the response was not a list`);

            fs.writeFileSync(file, JSON.stringify(servers, null, 4));
        })
        .catch(() => console.error("Could not load servers"));
}

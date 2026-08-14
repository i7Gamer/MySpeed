import fs from 'node:fs';

let ooklaServers;
let libreServers;

const OOKLA_FILE = "./data/servers/ookla.json";
const LIBRE_FILE = "./data/servers/librespeed.json";

/**
 * A downloaded server list, or nothing at all.
 *
 * These files are fetched in the background at boot and written with a plain
 * writeFileSync, which is not atomic - a container stopped mid-write, or a disk
 * that filled, leaves a truncated file behind. The parse used to run unguarded
 * out of a getter that three request paths reach: the metrics scrape, the
 * provider dialog's server list and librespeed's server selection. All three
 * answered 500 on a file that only needed downloading again.
 *
 * Read into a local and handed back only once it has parsed. The value used to
 * be assigned to the module's cache first and parsed in place, so a parse that
 * threw left the raw Buffer in the cache - and every later call took the early
 * return and handed that Buffer back as though it were the list. One
 * interrupted write turned into a silently wrong answer, everywhere, until the
 * process was restarted.
 */
const readServerList = (file) => {
    if (!fs.existsSync(file)) return [];

    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        console.error(`Could not read the server list at ${file}: ${error.message}`);
        return [];
    }
};

// Works for both shapes: ookla's list is an object keyed by server id and
// librespeed's is read the same way, so a length would answer undefined.
const holdsServers = (list) => Object.keys(list).length > 0;

export const getLibreServers = () => {
    if (libreServers) return libreServers;

    const list = readServerList(LIBRE_FILE);

    // Only a list with something in it is kept. Empty means the file is
    // missing, still downloading, or unreadable - each of which resolves on its
    // own, and caching the empty answer would outlive every one of them.
    if (holdsServers(list)) libreServers = list;

    return list;
}

export const getOoklaServers = () => {
    if (ooklaServers) return ooklaServers;

    const list = readServerList(OOKLA_FILE);
    if (holdsServers(list)) ooklaServers = list;

    return list;
}

export const getByMode = (mode) => {
    if (mode === "ookla") return getOoklaServers();
    if (mode === "libre") return getLibreServers();
}

import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import {checkOutboundHost} from "./safeUrl.js";
import {bareHost} from "./helpers.js";

export const SMTP_DNS_QUERY_TIMEOUT_MS = 30_000;
const SMTP_DNS_TTL_MS = 5 * 60 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 30_000;
const CACHE_CLEANUP_THRESHOLD = 1000;
const CACHE_EVICTION_FRACTION = 0.1;
const EMPTY_DNS_ERRORS = new Set([
    "ENODATA", "ENOTFOUND", "ENOTIMP", "ESERVFAIL", "ECONNREFUSED", "EREFUSED", "EAI_AGAIN"
]);
const defaultInterfaces = (() => {
    try { return os.networkInterfaces(); }
    catch { return undefined; }
})();
const defaultPolicy = address => checkOutboundHost(address).safe;
const blocked = () => Object.assign(new Error("SMTP destination has no permitted numeric address"),
    {code: "ESMTPDESTINATION"});

/**
 * Nodemailer's resolver runs before its native socket lookup. An ordinary
 * `lookup` option cannot filter those already-resolved addresses. Keep its
 * A/AAAA precedence, cached-answer availability and per-query timeout policy
 * here, filtering each fresh or cached candidate before the socket adapter can
 * dial it. The parity tests compare these rules with the installed mailer.
 *
 * Dependencies and the cache can be supplied by isolated tests. The shared
 * production instance below persists across notifications, just as the mailer's
 * cache did even though each notification creates a new transport.
 */
export const createSmtpResolver = ({dnsApi = dns, networkInterfaces = defaultInterfaces,
    now = () => Date.now(), random = () => Math.random(), checkAddress = defaultPolicy,
    cache = new Map()} = {}) => {
    let lastCleanup = 0;
    const supported = (family, allowInternal = false) => !networkInterfaces
        || Object.values(networkInterfaces).flat().some(entry => (allowInternal || !entry.internal)
            && (entry.family === `IPv${family}` || entry.family === family));
    const permitted = addresses => addresses.filter(address => net.isIP(address) && checkAddress(address));

    const lookup = (configuredHost, options, callback) => {
        const host = bareHost(configuredHost);
        let finished = false;
        const finish = (error, addresses) => {
            if (finished) return;
            finished = true;
            if (error) return callback(error);
            const safe = permitted(addresses);
            if (!safe.length) return callback(blocked());

            // Match the mailer's random initial address, then its original
            // fallback order, excluding duplicates of that first address.
            const first = safe[Math.floor(random() * safe.length)];
            const ordered = [first, ...safe.filter(address => address !== first)];
            if (options.all)
                return callback(null, ordered.map(address => ({address, family: net.isIP(address)})));
            callback(null, first, net.isIP(first));
        };
        if (net.isIP(host)) return finish(null, [host]);
        if (!checkAddress(host)) return finish(blocked());

        const cached = cache.get(host);
        if (cached) {
            const time = now();
            if (time - lastCleanup > CACHE_CLEANUP_INTERVAL_MS) {
                lastCleanup = time;
                for (const [key, value] of cache)
                    if (value.expires && value.expires < time) cache.delete(key);
                // Preserve the existing hit-triggered cleanup and fixed
                // eviction count. Tightening retention would lose previously
                // usable safe answers during a DNS outage; that is separate
                // from filtering destinations. Misses are not a strict bound.
                if (cache.size > CACHE_CLEANUP_THRESHOLD) {
                    const removeCount = Math.floor(CACHE_CLEANUP_THRESHOLD * CACHE_EVICTION_FRACTION);
                    for (const key of [...cache.keys()].slice(0, removeCount)) cache.delete(key);
                }
            }
            if (!cached.expires || cached.expires >= time) return finish(null, cached.addresses);
        }

        const store = addresses => {
            const safe = permitted(addresses);
            if (!safe.length) return finish(blocked());
            cache.set(host, {addresses: safe, expires: now() + (options.dnsTtl || SMTP_DNS_TTL_MS)});
            finish(null, safe);
        };
        const stale = error => cached ? store(cached.addresses) : finish(error);
        const resolveFamily = (family, done) => {
            if (!supported(family, options.allowInternalNetworkInterfaces)) return done(null, []);
            try {
                const resolver = dnsApi.Resolver
                    ? new dnsApi.Resolver({timeout: options.timeout || SMTP_DNS_QUERY_TIMEOUT_MS}) : dnsApi;
                resolver[`resolve${family}`](host, (error, addresses) => {
                    if (error) return done(EMPTY_DNS_ERRORS.has(error.code) ? null : error, []);
                    done(null, Array.isArray(addresses) ? addresses : [].concat(addresses || []));
                });
            } catch (error) { done(error, []); }
        };

        resolveFamily(4, (ipv4Error, ipv4) => resolveFamily(6, (ipv6Error, ipv6) => {
            const addresses = [...ipv4, ...ipv6];
            if (addresses.length) return store(addresses);
            if (ipv4Error && ipv6Error && cached) return stale(ipv4Error);
            try {
                dnsApi.lookup(host, {all: true}, (error, answers) => {
                    if (error) return stale(error);
                    const available = (answers || []).filter(answer => supported(answer.family))
                        .map(answer => answer.address);
                    if (!available.length && cached) return finish(null, cached.addresses);
                    // The mailer falls back to native hostname dialing when
                    // its interface snapshot excludes every OS result. Keep
                    // usable numeric results instead: loopback-only hosts
                    // still work without a second unchecked DNS lookup.
                    store(available.length ? available : (answers || []).map(answer => answer.address));
                });
            } catch (error) { stale(ipv4Error || ipv6Error || error); }
        }));
    };
    return {lookup};
};

export const smtpResolver = createSmtpResolver();

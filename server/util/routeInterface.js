import dgram from "node:dgram";

export const ROUTE_LOOKUP_TIMEOUT = 1000;
const ROUTE_PORT = 53;
const ROUTE_DESTINATIONS = [
    {family: "udp4", host: "1.1.1.1"},
    {family: "udp6", host: "2606:4700:4700::1111"}
];

/** Connect without sending, asking the OS which source address it would use. */
const routeAddress = ({family, host}, createSocket) => new Promise((resolve) => {
    let socket;
    let settled = false;
    let timer;
    const finish = (address = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A synchronous connect failure can leave the socket unbound.
        try { socket?.close(); } catch { /* Nothing remains open. */ }
        resolve(address);
    };

    try {
        socket = createSocket(family);
        socket.on("error", () => finish());
        timer = setTimeout(() => finish(), ROUTE_LOOKUP_TIMEOUT);
        socket.connect(ROUTE_PORT, host, () => {
            if (settled) return;
            try { finish(socket.address().address); } catch { finish(); }
        });
    } catch {
        finish();
    }
});

/**
 * Prefer the adapter routing toward a public destination, IPv4 then IPv6.
 * This is a route hint, not proof that every provider uses the same route.
 * Use the refresh's snapshot and retain VPNs as eligible adapters.
 * Socket creation is injectable so tests never consult the host's network.
 */
export const getDefaultRouteInterface = async (adapters, {createSocket = dgram.createSocket} = {}) => {
    for (const destination of ROUTE_DESTINATIONS) {
        const localAddress = await routeAddress(destination, createSocket);
        if (!localAddress) continue;
        const match = Object.entries(adapters).find(([, addresses]) =>
            addresses.some((entry) => !entry.internal && entry.address === localAddress));
        if (match) return {name: match[0], address: localAddress};
    }
    return null;
};

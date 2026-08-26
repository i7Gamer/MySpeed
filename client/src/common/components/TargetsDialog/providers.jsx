import {faServer} from "@fortawesome/free-solid-svg-icons";
import OoklaImage from "./assets/img/ookla.webp";
import LibreImage from "./assets/img/libre.webp";
import CloudflareImage from "./assets/img/cloudflare.webp";

/**
 * Every provider a target can measure with, in the order the cards are drawn.
 * Shared by the target editor and the welcome wizard's chooser, so the two
 * lists cannot drift apart.
 *
 * The names are proper nouns and deliberately untranslated - the description
 * under each card is where the locale speaks.
 *
 * iperf3 carries a glyph rather than a logo, and not for want of an asset: the
 * other three are services with a brand, and this one is a tool measuring
 * against a machine the operator runs. A server is what the card is actually
 * about.
 */
export const providers = [
    {id: "ookla", name: "Ookla", image: OoklaImage},
    {id: "libre", name: "LibreSpeed", image: LibreImage},
    {id: "cloudflare", name: "Cloudflare", image: CloudflareImage},
    {id: "iperf3", name: "iperf3", icon: faServer}
];

export const providerById = (id) => providers.find((provider) => provider.id === id) ?? null;

/**
 * The field rules live in providerFields.js - a plain module, because the
 * logos above make this one unloadable outside a bundler - and are re-exported
 * here so a caller that wants both has one import.
 */
export {takesServerId, takesEndpoint, requiresEndpoint} from "./providerFields.js";

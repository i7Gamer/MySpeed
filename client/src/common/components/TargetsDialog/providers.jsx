import OoklaImage from "./assets/img/ookla.webp";
import LibreImage from "./assets/img/libre.webp";
import CloudflareImage from "./assets/img/cloudflare.webp";
import IperfImage from "./assets/img/iperf3.png";
import OpenSpeedTestImage from "./assets/img/openspeedtest.png";

/**
 * Every provider a target can measure with, in the order the cards are drawn.
 * Shared by the target editor and the welcome wizard's chooser, so the two
 * lists cannot drift apart.
 *
 * The names are proper nouns and deliberately untranslated - the description
 * under each card is where the locale speaks.
 *
 * Logos are bundled locally, including the self-hosted providers: selecting
 * a provider must not contact its website to load its artwork. Upstream asset
 * provenance and notices are in public/provider-logo-notices.txt.
 */
export const providers = [
    {id: "ookla", name: "Ookla", image: OoklaImage},
    {id: "libre", name: "LibreSpeed", image: LibreImage},
    {id: "cloudflare", name: "Cloudflare", image: CloudflareImage},
    {id: "iperf3", name: "iperf3", image: IperfImage},
    {id: "openspeedtest", name: "OpenSpeedTest", image: OpenSpeedTestImage}
];

export const providerById = (id) => providers.find((provider) => provider.id === id) ?? null;

/**
 * The field rules live in providerFields.js - a plain module, because the
 * logos above make this one unloadable outside a bundler - and are re-exported
 * here so a caller that wants both has one import.
 */
export {
    takesServerId, takesEndpoint, requiresEndpoint, iperfHostAccepted, ostEndpointAccepted, ostSupportsCertificateBypass,
    takesTuning, durationAccepted, streamsAccepted, bitrateAccepted, tuningAccepted,
    TUNING_BOUNDS, IPERF_DEFAULTS, baselineAccepted, BASELINE_BOUNDS, BASELINE_PERCENT_DEFAULT
} from "./providerFields.js";

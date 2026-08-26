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
 */
export const providers = [
    {id: "ookla", name: "Ookla", image: OoklaImage},
    {id: "libre", name: "LibreSpeed", image: LibreImage},
    {id: "cloudflare", name: "Cloudflare", image: CloudflareImage}
];

export const providerById = (id) => providers.find((provider) => provider.id === id) ?? null;

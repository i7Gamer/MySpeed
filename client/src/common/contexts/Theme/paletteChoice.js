/**
 * Which hue family the interface wears.
 *
 * Independent of the theme, and stamped as its own attribute, so the two
 * compose rather than multiply: `data-palette="nord"` says which colours,
 * `data-theme="light"` says which mode of them. Four names here and eight
 * blocks in _colors.sass, not sixteen selectors either side.
 *
 * The names are the map keys in _colors.sass. Nothing at build time joins the
 * two - a name here with no block there resolves to whatever the last matching
 * selector left on the document, which is the outgoing palette - so
 * paletteChoice.test.js compares this list against the compiled stylesheet.
 * That is the same check that would have caught the email and mqtt icons.
 */
export const PALETTE_SLATE = "slate";
export const PALETTE_NORD = "nord";
export const PALETTE_CARBON = "carbon";
export const PALETTE_EMBER = "ember";

export const PALETTES = [PALETTE_SLATE, PALETTE_NORD, PALETTE_CARBON, PALETTE_EMBER];

/** What an instance that has never been told wears. The colours MySpeed shipped with. */
export const DEFAULT_PALETTE = PALETTE_SLATE;

/**
 * A stored palette, or the default where it is not one we have.
 *
 * Storage outlives releases: a name dropped in a later version is still in
 * localStorage on every machine that chose it, and an unknown `data-palette`
 * matches no block at all - the document would keep the default's properties
 * while the dialog showed a palette nobody can see.
 */
export const normalisePalette = (stored) => PALETTES.includes(stored) ? stored : DEFAULT_PALETTE;

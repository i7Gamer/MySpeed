/**
 * The status badge: a small SVG for a README or a status page - upstream
 * #936 asks for something embeddable - saying what the headline line last
 * measured, or that it is down.
 *
 * Drawn by hand rather than through satori and resvg, which the OpenGraph
 * card goes through: a badge is two rectangles and two strings, the shape
 * shields.io draws, and a PNG of it would be the one thing a README cannot
 * scale. Hand-drawn also means no native addon on the request path, so the
 * route costs a query and a template.
 *
 * Pure over what the controller read: the label and the metric come off the
 * request, the readings off the newest row, and everything here can be asked
 * without either.
 */

export const BADGE_LABEL_DEFAULT = "MySpeed";

/** Long enough for "Office line (Telekom)", short enough that a badge stays a badge. */
export const BADGE_LABEL_MAX_LENGTH = 40;

/** What the right half may show: every reading, or one of them. */
export const BADGE_METRICS = ["all", "download", "upload", "ping"];

const ALL_METRICS = BADGE_METRICS[0];

export const BADGE_STATUS = Object.freeze({
    UP: "up",
    DOWN: "down",
    UNKNOWN: "unknown",
    PRIVATE: "private"
});

/** shields.io's own green, red and grey, so a badge beside a build badge reads as one row. */
export const BADGE_COLOURS = Object.freeze({
    [BADGE_STATUS.UP]: "#4c1",
    [BADGE_STATUS.DOWN]: "#e05d44",
    [BADGE_STATUS.UNKNOWN]: "#9f9f9f",
    [BADGE_STATUS.PRIVATE]: "#9f9f9f"
});

const LABEL_BACKGROUND = "#555";

/** The words the right half says when there is no figure to print. */
const STATUS_WORDS = Object.freeze({
    [BADGE_STATUS.DOWN]: "down",
    [BADGE_STATUS.UNKNOWN]: "no data",
    [BADGE_STATUS.PRIVATE]: "private"
});

const NOT_MEASURED = "N/A";
const SPEED_UNIT = "Mbps";
const LATENCY_UNIT = "ms";
const SPEED_DECIMALS = 1;

/*
 * The geometry shields.io draws its flat badges with: 20 px tall, 11 px
 * Verdana, five pixels of padding either side of a string, and a character
 * that averages six and a half pixels. The text is drawn with textLength so
 * the estimate only has to be close - the renderer fits the glyphs to it.
 */
const HEIGHT = 20;
const FONT_SIZE = 11;
const PADDING = 5;
const CHAR_WIDTH = 6.5;
const CORNER_RADIUS = 3;
const TEXT_BASELINE = 14;
const SHADOW_OFFSET = 1;
const SHADOW_OPACITY = 0.3;

/** Only what an XML text node or attribute cannot carry raw. */
export const escapeXml = (text) => String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * The label the request named, or the product name.
 *
 * Control characters are dropped rather than escaped: none of them belongs in
 * a badge, and a newline in an attribute is how an SVG stops being one. The
 * cap keeps a badge from being made a banner by a long query string.
 */
export const badgeLabel = (raw) => {
    if (typeof raw !== "string") return BADGE_LABEL_DEFAULT;

    // Cut by glyph, not by code unit: a cut through a surrogate pair leaves a
    // lone surrogate that renders as a broken glyph.
    // eslint-disable-next-line no-control-regex
    const clean = [...raw.replace(/[\x00-\x1f\x7f]/g, "").trim()].slice(0, BADGE_LABEL_MAX_LENGTH).join("");

    return clean === "" ? BADGE_LABEL_DEFAULT : clean;
};

/** One of the four metrics, or all of them for anything that is not one. */
export const badgeMetric = (raw) => BADGE_METRICS.includes(raw) ? raw : ALL_METRICS;

const figure = (value, decimals) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return NOT_MEASURED;

    const rounded = Number(value.toFixed(decimals));

    return String(rounded);
};

const speed = (value) => figure(value, SPEED_DECIMALS);
const latency = (value) => figure(value, 0);

/**
 * What the right half says.
 *
 * A line that is not up says so in a word and prints no figure, whatever the
 * row beside the status carries: a "down" beside a download is a badge that
 * contradicts itself.
 */
export const badgeText = (reading, metric) => {
    if (reading?.status !== BADGE_STATUS.UP) return STATUS_WORDS[reading?.status] ?? STATUS_WORDS[BADGE_STATUS.UNKNOWN];

    const download = `↓ ${speed(reading.download)}`;
    const upload = `↑ ${speed(reading.upload)}`;
    const ping = `${latency(reading.ping)} ${LATENCY_UNIT}`;

    if (metric === "download") return `${download} ${SPEED_UNIT}`;
    if (metric === "upload") return `${upload} ${SPEED_UNIT}`;
    if (metric === "ping") return ping;

    return `${download} ${upload} ${SPEED_UNIT} · ${ping}`;
};

/**
 * Where the wide scripts start: CJK, Hangul and their punctuation all sit
 * above this, and each takes roughly two Latin glyphs' worth of width.
 */
const WIDE_GLYPHS_FROM = 0x2E80;
const WIDE_GLYPH_FACTOR = 2;

const glyphWidth = (glyph) => glyph.codePointAt(0) >= WIDE_GLYPHS_FROM ? CHAR_WIDTH * WIDE_GLYPH_FACTOR : CHAR_WIDTH;

// Per glyph rather than per code unit, so a label in Chinese is not fitted
// into half its width and an emoji is not counted twice.
const textWidth = (text) => Math.ceil([...text].reduce((width, glyph) => width + glyphWidth(glyph), 0)) + PADDING * 2;

/**
 * The badge itself.
 *
 * Two rectangles under one rounded mask, a gradient for the slight sheen, and
 * each string drawn twice - a dark copy offset by a pixel for the shadow, then
 * the white one - which is the flat shields.io style to the pixel. The title
 * is what a screen reader, and a hover, gets.
 *
 * Nothing in it can fetch or run: no script, no link, no image, no external
 * font, so the SVG is safe to serve to anyone the route admits.
 */
export const renderBadge = ({label, text, status}) => {
    const leftWidth = textWidth(label);
    const rightWidth = textWidth(text);
    const width = leftWidth + rightWidth;
    const colour = BADGE_COLOURS[status] ?? BADGE_COLOURS[BADGE_STATUS.UNKNOWN];

    const safeLabel = escapeXml(label);
    const safeText = escapeXml(text);

    const string = (content, x, length) =>
        `<text x="${x}" y="${TEXT_BASELINE + SHADOW_OFFSET}" fill="#010101" fill-opacity="${SHADOW_OPACITY}" textLength="${length}">${content}</text>`
        + `<text x="${x}" y="${TEXT_BASELINE}" textLength="${length}">${content}</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="${safeLabel}: ${safeText}">`
        + `<title>${safeLabel}: ${safeText}</title>`
        + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
        + `<clipPath id="r"><rect width="${width}" height="${HEIGHT}" rx="${CORNER_RADIUS}" fill="#fff"/></clipPath>`
        + `<g clip-path="url(#r)">`
        + `<rect width="${leftWidth}" height="${HEIGHT}" fill="${LABEL_BACKGROUND}"/>`
        + `<rect x="${leftWidth}" width="${rightWidth}" height="${HEIGHT}" fill="${colour}"/>`
        + `<rect width="${width}" height="${HEIGHT}" fill="url(#s)"/>`
        + `</g>`
        + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="${FONT_SIZE}">`
        + string(safeLabel, leftWidth / 2, leftWidth - PADDING * 2)
        + string(safeText, leftWidth + rightWidth / 2, rightWidth - PADDING * 2)
        + `</g>`
        + `</svg>`;
};

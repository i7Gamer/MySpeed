import express from 'express';
import passwordWrapper from '../middlewares/passwordWrapper.js';
import { readBadge } from '../controller/badge.js';
import { BADGE_STATUS, badgeLabel, badgeMetric, badgeText, renderBadge } from '../util/badge.js';

const app = express.Router();

const SVG_TYPE = "image/svg+xml; charset=utf-8";

/**
 * How long a proxy or GitHub's image cache may keep one.
 *
 * Five minutes, which is what shields.io asks for: a README is read far more
 * often than a line is measured, and the default schedule measures hourly.
 * Not `no-store` - that turns every render of a README into a request here.
 */
const BADGE_CACHE_SECONDS = 300;

/**
 * Sends one badge, whatever the reading. The status decides the colour and
 * the words; the request decides the label and which readings to print.
 */
const send = (req, res, reading) => {
    const metric = badgeMetric(req.query.metric);
    const svg = renderBadge({
        label: badgeLabel(req.query.label),
        text: badgeText(reading, metric),
        status: reading.status
    });

    res.setHeader("Content-Type", SVG_TYPE)
        .setHeader("Cache-Control", `public, max-age=${BADGE_CACHE_SECONDS}`)
        .status(200)
        .send(svg);
};

/**
 * GET /api/badge?label=...&metric=all|download|upload|ping
 *
 * Behind the same door as the OpenGraph card: open when the instance has no
 * password or lets strangers read, and a grey "private" badge otherwise -
 * still a badge, since what asked for it is an <img> that cannot follow a
 * JSON refusal. A demo is admitted the way it is everywhere: the figures
 * are what the simulation made up.
 */
app.get("/", passwordWrapper(true, (req, res) => {
    send(req, res, {status: BADGE_STATUS.PRIVATE});
}), async (req, res, next) => {
    try {
        send(req, res, await readBadge());
    } catch (error) {
        next(error);
    }
});

export default app;

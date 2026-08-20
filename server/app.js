import express from 'express';
import path from 'node:path';
import fs from 'node:fs';

// Must run before anything imports the database, which resolves its file
// relative to the working directory.
import './util/createFolders.js';

import errorMiddleware from './middlewares/error.js';
import securityHeaders from './middlewares/securityHeaders.js';
import httpsRedirect from './middlewares/httpsRedirect.js';
import { createRateLimit } from './middlewares/rateLimit.js';
import { parseTrustProxy } from './util/trustProxy.js';
import configRoutes from './routes/config.js';
import sessionRoutes from './routes/session.js';
import speedtestsRoutes from './routes/speedtests.js';
import systemRoutes from './routes/system.js';
import storageRoutes, { isLargeBodyPath } from './routes/storage.js';
import recommendationsRoutes from './routes/recommendations.js';
import nodesRoutes from './routes/nodes.js';
import integrationsRoutes from './routes/integrations.js';
import prometheusRoutes from './routes/prometheus.js';
import opengraphRoutes from './routes/opengraph.js';
import healthRoutes from './routes/health.js';

/**
 * The HTTP layer on its own: routing, middleware and client delivery.
 *
 * Deliberately free of runtime side effects - it opens no ports, starts no
 * timers, downloads nothing and reaches no network. Everything that does live
 * in index.js, which keeps this module importable by tests.
 */
// Enough for every request the UI makes. The two import endpoints opt back into
// a large body themselves, behind their own authentication. It used to be 50mb
// for everything, applied before any password check ran, so an anonymous caller
// could make the server buffer and parse 50mb of JSON at will.
const JSON_BODY_LIMIT = '100kb';

const RATE_LIMIT_WINDOW_MS = 60000;

// Generous: the dashboard polls for new tests every five seconds and several
// tabs may be open. This is a backstop against a stranger monopolising the
// instance, not a quota.
const API_REQUESTS_PER_MINUTE = 300;

// Rendering the OpenGraph PNG runs a database query, a satori layout pass and a
// resvg rasterisation, and the range export can walk a year of rows. Both are
// deliberate one-off actions - a download, a link being unfurled - so twenty a
// minute is well clear of ordinary use.
const EXPENSIVE_REQUESTS_PER_MINUTE = 20;

/**
 * The statistics aggregation reads every row in the range, with no limit on the
 * query at all: "all time" on a year of five-minute tests is around a hundred
 * thousand rows materialised per call, and on a demo the password middleware
 * admits everyone. It sat behind the 300/min backstop alone while /export, which
 * reads the same rows to answer the same page, sat behind 20.
 *
 * Its own number rather than the expensive one, because it is not the same kind
 * of request. Export is a download somebody clicks; this is what the statistics
 * page reads, and it re-reads on every timeframe and range change - so twenty a
 * minute is a limit an interested reader can reach by clicking around, and being
 * told to slow down for using the page is worse than the load it saves. Sixty is
 * a request a second sustained, which no one does by hand and which still cuts
 * the worst case by five.
 */
const STATISTICS_REQUESTS_PER_MINUTE = 60;

// A scrape every fifteen seconds is four a minute.
const METRICS_REQUESTS_PER_MINUTE = 60;

const devModeHtmlPath = path.join(process.cwd(), 'server', 'templates', 'env.html');
const devModeHtml = fs.existsSync(devModeHtmlPath) ? fs.readFileSync(devModeHtmlPath, 'utf-8') : '';

let embeddedClient = null;
try {
    embeddedClient = await import('./clientEmbed.js');
} catch {
    // Generated only for the compiled binary, so running from source is the
    // ordinary case rather than a failure - the static handler falls back to
    // serving ./build from the working directory.
}

const app = express();

app.disable('x-powered-by');

// Opt-in, and only the operator knows the answer: see util/trustProxy.js. It has
// to be set before anything reads req.ip, which both rate limiters and the
// password throttle do.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

app.use(httpsRedirect());
app.use(securityHeaders());

// body-parser marks the request as read, so whichever parser runs first wins.
// The import routes are skipped here and parse their own body after their
// password check, which is what keeps the large limit behind authentication.
const smallJsonBody = express.json({ limit: JSON_BODY_LIMIT });

app.use((req, res, next) => isLargeBodyPath(req.path) ? next() : smallJsonBody(req, res, next));

// Mounted before the authenticated routes and before the rate limiter: the
// probe must answer regardless of how the instance is locked down, and a
// container healthcheck must never be throttled out of existence.
app.use("/api/health", healthRoutes);

/**
 * Every limiter this module builds, so a test can put them back as they were.
 *
 * A rate limiter measured by a suite is measuring the wrong thing: the
 * integration files drive one endpoint dozens of times from one address in a few
 * seconds, which is not a shape any caller produces and not what the limit is
 * about. Without a way to clear them, adding a limit to a route silently turns
 * every test of that route into a test of the limiter.
 */
const rateLimiters = [];

const limited = (options) => {
    const middleware = createRateLimit({windowMs: RATE_LIMIT_WINDOW_MS, ...options});
    rateLimiters.push(middleware);
    return middleware;
};

export const resetRateLimits = () => rateLimiters.forEach((limiter) => limiter.reset());

app.use("/api", limited({limit: API_REQUESTS_PER_MINUTE}));

const expensiveLimit = () => limited({limit: EXPENSIVE_REQUESTS_PER_MINUTE});

app.use("/api/opengraph", expensiveLimit());
app.use("/api/speedtests/export", expensiveLimit());
app.use("/api/speedtests/run", expensiveLimit());

/*
 * The raw history, which is the export's unbounded sibling.
 *
 * /json and /csv under here answer with tests.listAll() - a findAll with no
 * limit - and hand the whole thing to res.send. At 200 000 rows that is 2.0 s to
 * read and 0.5 s to serialise, for a 122 MiB string Express then buffers. The
 * export above answers the same rows for a *date range* and has been held to 20
 * a minute all along, so the bounded reader was capped four times more tightly
 * than the two unbounded ones.
 *
 * The prefix rather than the two leaves: the PUT that restores a history and the
 * DELETE that empties it are the other two expensive things on this path, and
 * neither is something to do twenty times a minute either.
 */
app.use("/api/storage/tests/history", expensiveLimit());
app.use("/api/speedtests/statistics", limited({limit: STATISTICS_REQUESTS_PER_MINUTE}));
app.use("/api/prometheus", limited({limit: METRICS_REQUESTS_PER_MINUTE}));

app.use("/api/session", sessionRoutes);
app.use("/api/config", configRoutes);
app.use("/api/speedtests", speedtestsRoutes);
app.use("/api/info", systemRoutes);
app.use("/api/storage", storageRoutes);
app.use("/api/recommendations", recommendationsRoutes);
app.use("/api/nodes", nodesRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/prometheus", prometheusRoutes);
app.use('/api/opengraph', opengraphRoutes);
app.use("/api*all", (req, res) => res.status(404).json({message: "Route not found"}));

let buildPath = path.join(process.cwd(), 'build');
let buildExists = fs.existsSync(buildPath);

if (buildExists) {
    app.use(express.static(buildPath));
    app.get('*all', (req, res) => res.sendFile(path.join(buildPath, 'index.html')));
} else if (embeddedClient) {
    app.use(embeddedClient.createEmbeddedMiddleware());
    app.get('*all', embeddedClient.createEmbeddedFallback());
} else {
    app.get("*all", (req, res) => res.status(500).type('html').send(devModeHtml));
}

// Last, not first: an error handler only sees what is thrown downstream of
// where it is mounted. In front of the routers it caught the body parser and
// nothing else, so anything a route threw fell through to Express's default
// handler and came back as an HTML page with a stack trace in it.
app.use(errorMiddleware);

export default app;

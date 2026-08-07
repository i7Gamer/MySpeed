import express from 'express';
import path from 'node:path';
import fs from 'node:fs';

// Must run before anything imports the database, which resolves its file
// relative to the working directory.
import './util/createFolders.js';

import errorMiddleware from './middlewares/error.js';
import configRoutes from './routes/config.js';
import speedtestsRoutes from './routes/speedtests.js';
import systemRoutes from './routes/system.js';
import storageRoutes from './routes/storage.js';
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
const devModeHtmlPath = path.join(process.cwd(), 'server', 'templates', 'env.html');
const devModeHtml = fs.existsSync(devModeHtmlPath) ? fs.readFileSync(devModeHtmlPath, 'utf-8') : '';

let embeddedClient = null;
try {
    embeddedClient = await import('./clientEmbed.js');
} catch {

}

const app = express();

app.disable('x-powered-by');

app.use(express.json({ limit: '50mb' }));

// Mounted before the authenticated routes: the probe must answer regardless of
// how the instance is locked down.
app.use("/api/health", healthRoutes);

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

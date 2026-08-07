import express from 'express';
import db from '../config/database.js';

const app = express.Router();

/**
 * Liveness and readiness probe.
 *
 * Deliberately unauthenticated: a container healthcheck, a load balancer or an
 * uptime monitor cannot present the configured password, and an endpoint that
 * 401s under a password lock is useless as a probe. It therefore discloses
 * nothing but liveness - no version, no configuration, no counts.
 *
 * It also makes no outbound request, which is what rules out /info/version as a
 * probe: that one calls the GitHub API and fails whenever the host is offline,
 * even though the instance itself is perfectly healthy.
 */
app.get("/", async (req, res) => {
    try {
        await db.authenticate();
    } catch {
        return res.status(503).json({status: "error", database: "down", uptime: Math.floor(process.uptime())});
    }

    res.json({status: "ok", database: "up", uptime: Math.floor(process.uptime())});
});

export default app;

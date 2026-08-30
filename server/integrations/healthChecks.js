import { postJson } from "../util/http.js";
import { stripTrailingSlashes } from "../util/helpers.js";

const FAILURE_PATH = "fail";

/**
 * The round's events, not the members'.
 *
 * healthchecks.io models one check as one monitored thing: /start opens a
 * timing window and the next ping closes it. The per-member events fire once
 * per target, so a multi-target round answered its one /start with N pings -
 * and the last member won: a watched line's /fail was taken back seconds
 * later by the next member's success, and the check ended the round "up"
 * while the line was still down. So this module listens to the round's own
 * completion, which carries whether anything watched failed, and leaves the
 * per-member events to the sinks that describe tests rather than runs.
 */
const events = [
    ['minutePassed'],
    ['testStarted', "start"],
    ['roundFinished']
];

/**
 * Where a ping goes, which depends on how the line is doing.
 *
 * The root URL is healthchecks.io's *success* endpoint, and the keep-alive used
 * it unconditionally - so a minute after a round failed and /fail was pinged,
 * the keep-alive reported the check up again and took the failure back. Unless
 * somebody happened to be looking during that minute, the notification an
 * operator most wants was never seen at all.
 *
 * Routed rather than withheld. Staying silent would have fixed the overwrite
 * and cost the other thing this ping is for: it is the only signal that MySpeed
 * itself is still running, so an instance that failed a test and then died
 * would have been indistinguishable from one whose line is merely down. Sent to
 * /fail instead, the check keeps the state the round gave it *and* its
 * last-ping time keeps moving, which is what tells those two apart.
 *
 * The round's completion is routed by the same judgement: /fail while anything
 * watched failed, success otherwise. `testFailing` is read from the stored
 * tests in tasks/integrations.js rather than remembered in this process, so a
 * restart between a failure and the next round cannot forget it - and it asks
 * "does any watched target's newest result stand as a failure", the very rule
 * the round's own ping just applied.
 */
const pathFor = (event, path, payload) => {
    if (event === 'minutePassed' && payload?.testFailing) return FAILURE_PATH;
    if (event === 'roundFinished' && payload?.failed) return FAILURE_PATH;

    return path;
};

/**
 * The payload without the flag above.
 *
 * healthchecks.io stores the ping body and shows it as that ping's log entry.
 * `testFailing` is an instruction about which URL to use, not something the
 * operator asked to record, and leaving it in wrote a line of MySpeed's routing
 * state into their log once a minute for as long as the instance ran.
 *
 * roundFinished's `failed` stays in on purpose: it routes too, but it is the
 * round's actual outcome, which is exactly what a ping log is for.
 *
 * The nullish default rather than a parameter one, because `payload` is null on
 * an event that carries nothing and a default only covers undefined.
 */
const bodyFor = (payload) => {
    const {testFailing, ...rest} = payload ?? {};

    return rest;
};

export default (registerEvent) => {
    for (const [event, path] of events) {
        registerEvent(event, async ({data: c}, payload, activity) => {
            if (!c.url) return;

            // Stripped first, the way the ntfy module beside this one already
            // does it. A url copied out of a browser's address bar ends in a
            // slash, and `${c.url}/${path}` then produced .../uuid//start - an
            // empty path segment, which the ping endpoint answers 404 to. The
            // check reported as down and the integration reported as working.
            const url = stripTrailingSlashes(c.url);
            const target = pathFor(event, path, payload);

            await postJson(target ? `${url}/${target}` : url, bodyFor(payload),
                {headers: {"user-agent": "MySpeed/HealthAgent"}, activity});
        });
    }

    return {
        icon: "fa-solid fa-heart-pulse",
        fields: [
            {name: "url", type: "text", required: true, secret: true, regex: /^https?:\/\/\S+$/},
            {name: "interval", type: "number", required: false, min: 1, max: 1440}
        ]
    };
};

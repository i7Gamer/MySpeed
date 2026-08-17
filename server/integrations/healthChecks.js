import { postJson } from "../util/http.js";
import { stripTrailingSlashes } from "../util/helpers.js";

const FAILURE_PATH = "fail";

const events = [
    ['minutePassed'],
    ['testStarted', "start"],
    ['testFinished'],
    ['testFailed', FAILURE_PATH]
];

/**
 * Where a ping goes, which for the keep-alive depends on the last test.
 *
 * The root URL is healthchecks.io's *success* endpoint, and the keep-alive used
 * it unconditionally - so a minute after a test failed and /fail was pinged,
 * the keep-alive reported the check up again and took the failure back. Unless
 * somebody happened to be looking during that minute, the notification an
 * operator most wants was never seen at all.
 *
 * Routed rather than withheld. Staying silent would have fixed the overwrite
 * and cost the other thing this ping is for: it is the only signal that MySpeed
 * itself is still running, so an instance that failed a test and then died
 * would have been indistinguishable from one whose line is merely down. Sent to
 * /fail instead, the check keeps the state the test gave it *and* its last-ping
 * time keeps moving, which is what tells those two apart.
 *
 * Only the keep-alive is routed: the other three carry their own outcome, and a
 * finished test landing on /fail would leave the check down after the line came
 * back. `testFailing` is read from the stored tests in tasks/integrations.js
 * rather than remembered in this process, so a restart between a failure and
 * the next test cannot forget it.
 */
const pathFor = (event, path, payload) =>
    event === 'minutePassed' && payload?.testFailing ? FAILURE_PATH : path;

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

            await postJson(target ? `${url}/${target}` : url, payload ?? {},
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

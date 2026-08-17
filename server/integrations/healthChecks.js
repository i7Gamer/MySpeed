import { postJson } from "../util/http.js";
import { stripTrailingSlashes } from "../util/helpers.js";

const events = [
    ['minutePassed'],
    ['testStarted', "start"],
    ['testFinished'],
    ['testFailed', "fail"]
];

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

            await postJson(path ? `${url}/${path}` : url, payload ?? {},
                {headers: {"user-agent": "MySpeed/HealthAgent"}, activity});
        });
    }

    return {
        // The keep-alive above goes to the same URL a finished test does, which
        // is the success endpoint - so left to itself it reported the check up
        // again within a minute of a failure and took the /fail ping back.
        // suppressesKeepAlive in controller/integrations.js explains the flag;
        // only a test that actually succeeds clears a failure now.
        aliveMeansHealthy: true,
        icon: "fa-solid fa-heart-pulse",
        fields: [
            {name: "url", type: "text", required: true, secret: true, regex: /^https?:\/\/\S+$/},
            {name: "interval", type: "number", required: false, min: 1, max: 1440}
        ]
    };
};

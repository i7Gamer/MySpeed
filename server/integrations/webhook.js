import { postJson } from "../util/http.js";
import { wantsDigest } from "../util/digestOptIn.js";

const send = (url, event, data, activity) =>
    postJson(url, {event, data}, {headers: {"user-agent": "MySpeed/WebhookAgent"}, activity});

const events = [
    ['testStarted', 'send_started', "TEST_STARTED"],
    ['minutePassed', 'send_alive', "KEEP_ALIVE"],
    ['testFinished', 'send_finished', "TEST_FINISHED", (d) => d],
    ['testFailed', 'send_failed', "TEST_FAILED", (d) => d],
    ['recommendationsUpdated', 'send_recommendations', "RECOMMENDATIONS_UPDATED", (d) => d],
    ['configUpdated', 'send_config_updates', "CONFIG_UPDATED", (d) => d]
];

const DIGEST_TYPE = "DIGEST";


export default (registerEvent) => {
    for (const [event, flag, type, getData] of events) {
        registerEvent(event, async ({data: c}, payload, activity) => {
            if (c[flag]) await send(c.url, type, getData?.(payload), activity);
        });
    }

    /**
     * Registered on its own because the table above cannot say this: a row
     * names one stored flag, and which flag a digest reads depends on the kind
     * the event carries - weekly and monthly are two switches on one event.
     *
     * The whole payload rather than the composed text, unlike every other
     * notifier here. A webhook is read by a program, which wants the window
     * and the counts as fields beside the wording rather than a paragraph to
     * take them back out of.
     */
    registerEvent('digestReady', async ({data: c}, payload, activity) => {
        if (wantsDigest(c, payload.kind)) await send(c.url, DIGEST_TYPE, payload, activity);
    });

    return {
        // Opts in to the shared threshold settings; isNotifier in
        // controller/integrations.js explains the flag.
        notifier: true,
        icon: "fa-solid fa-globe",
        fields: [
            {name: "url", type: "text", required: true, secret: true, regex: /^https?:\/\/\S+$/},
            {name: "send_started", type: "boolean", required: false},
            {name: "send_finished", type: "boolean", required: false},
            {name: "send_alive", type: "boolean", required: false},
            {name: "send_failed", type: "boolean", required: false},
            {name: "send_recommendations", type: "boolean", required: false},
            {name: "send_config_updates", type: "boolean", required: false},
            {name: "interval", type: "number", required: false, min: 1, max: 1440}
        ]
    };
};

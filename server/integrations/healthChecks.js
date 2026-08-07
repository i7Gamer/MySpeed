import { postJson } from "../util/http.js";

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
            await postJson(path ? `${c.url}/${path}` : c.url, payload ?? {},
                {headers: {"user-agent": "MySpeed/HealthAgent"}, activity});
        });
    }

    return {
        icon: "fa-solid fa-heart-pulse",
        fields: [
            {name: "url", type: "text", required: true, secret: true, regex: /https?:\/\/.+/},
            {name: "interval", type: "number", required: false, min: 1, max: 1440}
        ]
    };
};

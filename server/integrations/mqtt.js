import { publish } from "../util/mqtt.js";
import { checkOutboundHost } from "../util/safeUrl.js";
import { OUTBOUND_TIMEOUT, noteActivity } from "../util/integrationActivity.js";

/**
 * MQTT, which is upstream #1190 and #807.
 *
 * The second asks for "integration with Home Assistant" and the first for MQTT,
 * and they are one request: a Home Assistant entity is an MQTT topic somebody
 * publishes to. So this publishes the same flat JSON every other consumer gets -
 * the vocabulary the webhook, the CSV export and the API all describe a test in
 * - which a Home Assistant sensor reads straight off with `value_json.download`.
 *
 * The protocol lives in util/mqtt.js and is written out rather than taken from
 * the standard client; that file says why. What is left here is the same shape
 * every integration has, plus the two things a non-HTTP module cannot inherit
 * from util/http.js: the address guard and the activity note.
 */

/**
 * Where a failure goes when the operator named no topic for it.
 *
 * Its own topic rather than the base one, because the two payloads are different
 * shapes: a finished test carries the measurements and a failure carries
 * `error` and none of them. Published together, a Home Assistant sensor reads a
 * result and then a record with no numbers in it, and goes unavailable - so the
 * default separates them rather than leaving that to be discovered.
 */
const errorTopicFor = (topic) => `${topic}/error`;

const send = async (c, topic, payload, activity) => {
    const target = checkOutboundHost(c.host);

    if (!target.safe) {
        noteActivity(activity, true);
        console.error(`Integration request to ${c.host} failed: ${target.reason}`);

        return;
    }

    try {
        await publish({
            host: c.host,
            port: Number(c.port),
            secure: c.secure === true,
            username: c.username,
            password: c.password,
            clientId: c.client_id,
            topic,
            payload: Buffer.from(JSON.stringify(payload), "utf8"),
            // A number on the way in and a number here: validateInput coerces a
            // declared number field, but a row restored from a backup was
            // bulk-created without going through it.
            qos: Number(c.qos) === 1 ? 1 : 0,
            retain: c.retain === true,
            timeout: OUTBOUND_TIMEOUT
        });

        noteActivity(activity, false);
    } catch (error) {
        // Reported rather than thrown, like every other module's send:
        // triggerEvent works through the integrations one at a time, so a throw
        // escaping here takes the ones after it down with this one.
        noteActivity(activity, true);
        console.error(`Integration request to ${c.host} failed: ${error?.message ?? error}`);
    }
};

export default (registerEvent) => {
    registerEvent('testFinished', async ({data: c}, data, activity) => {
        if (c.send_finished) await send(c, c.topic, data, activity);
    });

    registerEvent('testFailed', async ({data: c}, failure, activity) => {
        if (c.send_failed) await send(c, c.error_topic || errorTopicFor(c.topic), failure, activity);
    });

    return {
        /*
         * Deliberately not a notifier.
         *
         * The shared threshold settings exist so that an operator is told only
         * when the line is bad, and this is a data sink rather than an alert: a
         * Home Assistant history with the good results filtered out is not a
         * history, and the graph drawn from it would describe a line that is
         * always failing.
         *
         * Which other modules abstain is deliberately not written down here -
         * integrationFields.js holds that set, and a copy in a module is a copy
         * that goes stale.
         */
        icon: "fa-solid fa-tower-broadcast",
        fields: [
            // A host or an address, not a URL: this is dialled directly, so a
            // scheme or a path names nothing here. Same pattern the email relay
            // uses, and anchored for the same reason.
            {name: "host", type: "text", required: true, regex: /^\[?[A-Za-z0-9._:-]+]?$/},
            {name: "port", type: "number", required: true, min: 1, max: 65535},
            // Implicit TLS, which is the mqtts convention on 8883. There is no
            // STARTTLS equivalent in MQTT, so this is the whole of the choice.
            {name: "secure", type: "boolean", required: false},
            // Neither half is required: an unauthenticated broker on a LAN is
            // the common case. The password is redacted; the username is a
            // credential too, and is withheld for the reason the email module
            // gives - it narrows a guess at the other half.
            {name: "username", type: "text", required: false, secret: true},
            {name: "password", type: "text", required: false, secret: true},
            // Optional. util/mqtt.js generates one per connection when this is
            // empty, which is right for a clean session - but a broker with
            // per-client ACLs needs to know the name in advance.
            {name: "client_id", type: "text", required: false, regex: /^[A-Za-z0-9._-]+$/},
            /*
             * `+` and `#` are subscription wildcards, and a broker refuses a
             * PUBLISH carrying either - so accepting one here would store a
             * topic that can never deliver, behind a save that reported success.
             * Whitespace is legal in a topic and is refused anyway: it is far
             * more often a typo than a choice, and it cannot be seen in the
             * field.
             */
            {name: "topic", type: "text", required: true, regex: /^[^+#\s]+$/},
            {name: "error_topic", type: "text", required: false, regex: /^[^+#\s]+$/},
            {name: "retain", type: "boolean", required: false},
            // Nothing above 1: the client acknowledges a PUBACK and no more, so
            // taking a 2 would store a level that quietly behaves as something
            // else.
            {name: "qos", type: "number", required: false, min: 0, max: 1},
            {name: "send_finished", type: "boolean", required: false},
            {name: "send_failed", type: "boolean", required: false}
        ]
    };
};

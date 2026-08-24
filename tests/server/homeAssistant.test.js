import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_DISCOVERY_PREFIX, SENSORS, deviceIdFrom, discoveryMessages
} from "../../server/util/homeAssistant.js";
import { FINISHED_VARIABLES } from "../../server/util/notificationPayload.js";

/**
 * Home Assistant discovery, which is the half of upstream #807 that makes it
 * land.
 *
 * Publishing to MQTT gets a Home Assistant user as far as writing an `mqtt:`
 * sensor block per metric in YAML and restarting. Discovery is a retained
 * message per sensor on `<prefix>/sensor/<object>/config` describing the entity,
 * after which the entities simply appear - which is what "integration with Home
 * Assistant" means to the person who asked for it.
 *
 * Retained is not optional here. The config is how Home Assistant learns the
 * entity exists at all, and it reads them when it starts rather than when we
 * publish - so a config that is not retained describes an entity to nobody.
 */
describe("the device identity", () => {
    /**
     * Derived from the topic rather than configured.
     *
     * It has to be stable across restarts - Home Assistant matches entities by
     * it - and distinct between two instances publishing to one broker. The
     * topic is already both: it is stored, and two instances sharing one would
     * be overwriting each other's results long before their entity ids collided.
     */
    it("is stable for a given topic", () => {
        assert.equal(deviceIdFrom("myspeed/result"), deviceIdFrom("myspeed/result"));
    });

    it("differs between two instances publishing to different topics", () => {
        assert.notEqual(deviceIdFrom("myspeed/home"), deviceIdFrom("myspeed/office"));
    });

    /**
     * Home Assistant object ids take letters, digits, hyphens and underscores.
     * A slash is what every MQTT topic is full of, and it would end the topic
     * segment early - putting the rest of the id where the word "config" belongs.
     */
    it("carries nothing that would break the topic it is put into", () => {
        for (const topic of ["myspeed/result", "a/b/c", "MySpeed Result", "hei§m/+#"])
            assert.match(deviceIdFrom(topic), /^[a-z0-9_-]+$/, `${topic} produced an unusable id`);
    });

    it("is never empty, whatever it was given", () => {
        for (const topic of ["", "///", "§§§", null, undefined])
            assert.ok(deviceIdFrom(topic).length > 0, `${JSON.stringify(topic)} produced an empty id`);
    });
});

describe("the sensors offered", () => {
    /**
     * Every one has to name a key the payload actually carries, or Home
     * Assistant creates an entity that is permanently unknown and nothing says
     * why. Read off the payload's own key list rather than a copy here.
     */
    it("read keys the published payload carries", () => {
        for (const sensor of SENSORS)
            assert.ok(FINISHED_VARIABLES.includes(sensor.key),
                `${sensor.key} is not in the finished payload, so its entity would never have a value`);
    });

    it("cover the measurements somebody would graph", () => {
        const keys = SENSORS.map((sensor) => sensor.key);

        for (const expected of ["download", "upload", "ping", "jitter", "packetLoss"])
            assert.ok(keys.includes(expected), `no sensor for ${expected}`);
    });

    it("each carry a unit and a name", () => {
        for (const sensor of SENSORS) {
            assert.ok(sensor.name, `${sensor.key} has no name`);
            assert.ok(sensor.unit, `${sensor.key} has no unit`);
        }
    });
});

describe("the discovery messages", () => {
    const built = () => discoveryMessages({
        stateTopic: "myspeed/result", prefix: DEFAULT_DISCOVERY_PREFIX, version: "1.3.5"
    });

    it("are one per sensor", () => {
        assert.equal(built().length, SENSORS.length);
    });

    it("go to the config topic Home Assistant watches", () => {
        for (const message of built())
            assert.match(message.topic, /^homeassistant\/sensor\/[a-z0-9_-]+\/[a-z0-9_-]+\/config$/,
                `${message.topic} is not where discovery is read from`);
    });

    it("go under a different prefix when the operator moved it", () => {
        const messages = discoveryMessages({stateTopic: "myspeed/result", prefix: "ha", version: "1.3.5"});

        for (const message of messages) assert.ok(message.topic.startsWith("ha/sensor/"));
    });

    /**
     * Retained, always. Home Assistant reads these when *it* starts, not when we
     * publish - so a config that is not retained is a config nobody ever sees,
     * and the entity never appears.
     */
    it("are retained whatever the state topic does", () => {
        for (const message of built()) assert.equal(message.retain, true);
    });

    it("point every sensor at the topic the results go to", () => {
        for (const message of built())
            assert.equal(JSON.parse(message.payload).state_topic, "myspeed/result");
    });

    it("read their own key out of the payload", () => {
        const download = built().find((message) => message.topic.includes("download"));

        assert.match(JSON.parse(download.payload).value_template, /value_json\.download/);
    });

    /**
     * Unique per entity and per instance. Two instances on one broker share the
     * discovery prefix, so an id that is only unique within an instance makes
     * the second one adopt the first one's entities.
     */
    it("give every entity an id unique to this instance", () => {
        const ids = built().map((message) => JSON.parse(message.payload).unique_id);
        const elsewhere = discoveryMessages({stateTopic: "myspeed/office", prefix: DEFAULT_DISCOVERY_PREFIX})
            .map((message) => JSON.parse(message.payload).unique_id);

        assert.equal(new Set(ids).size, ids.length, "two entities on one instance share an id");
        assert.equal(ids.filter((id) => elsewhere.includes(id)).length, 0,
            "a second instance would adopt the first one's entities");
    });

    /**
     * The device block is what groups the sensors into one thing in the
     * interface rather than seven loose entities, and every message has to carry
     * the same one for that to happen.
     */
    it("group the sensors under one device", () => {
        const devices = built().map((message) => JSON.stringify(JSON.parse(message.payload).device));

        assert.equal(new Set(devices).size, 1, "the sensors would appear as separate devices");
        assert.match(devices[0], /identifiers/);
        assert.match(devices[0], /1\.3\.5/, "the device does not say which version published it");
    });

    it("survive being built with no version to report", () => {
        const messages = discoveryMessages({stateTopic: "myspeed/result", prefix: DEFAULT_DISCOVERY_PREFIX});

        assert.equal(messages.length, SENSORS.length);
        assert.doesNotThrow(() => messages.forEach((message) => JSON.parse(message.payload)));
    });

    it("declare a unit and a state class so history is graphable", () => {
        const payload = JSON.parse(built()[0].payload);

        assert.ok(payload.unit_of_measurement);
        assert.equal(payload.state_class, "measurement");
    });
});

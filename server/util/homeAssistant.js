/**
 * Home Assistant discovery, which is the half of upstream #807 that makes it
 * land.
 *
 * Publishing to MQTT gets a Home Assistant user as far as writing an `mqtt:`
 * sensor block per metric into their YAML and restarting. Discovery is a
 * retained message per sensor, on a topic Home Assistant watches, describing the
 * entity it should create - after which the entities simply appear, which is
 * what "integration with Home Assistant" means to the person who asked.
 *
 * Retained is not a setting here. Home Assistant reads these when *it* starts
 * rather than when we publish, so a config that is not retained describes an
 * entity to nobody.
 */

/** Where Home Assistant listens unless its own configuration moved it. */
export const DEFAULT_DISCOVERY_PREFIX = "homeassistant";

/**
 * The measurements worth an entity, with the units and classes that let Home
 * Assistant graph them rather than list them as text.
 *
 * `state_class: measurement` is what puts a sensor in the statistics engine, so
 * long-term history and the statistics card work. `device_class` gives it the
 * right icon and unit conversion; packet loss has no class because a percentage
 * of lost packets is not one of the kinds Home Assistant knows.
 *
 * Every key here has to be one the published payload actually carries -
 * notificationPayload.js owns that list, and the test holds the two together.
 * The four nullable ones only arrive from Ookla; the others report nothing for
 * them, and an entity with no value is the honest rendering of that.
 */
export const SENSORS = [
    {key: "download", name: "Download", unit: "Mbit/s", deviceClass: "data_rate"},
    {key: "upload", name: "Upload", unit: "Mbit/s", deviceClass: "data_rate"},
    {key: "ping", name: "Ping", unit: "ms", deviceClass: "duration"},
    {key: "jitter", name: "Jitter", unit: "ms", deviceClass: "duration"},
    {key: "packetLoss", name: "Packet loss", unit: "%"},
    // What the line does while it is saturated, as against idle - the pair that
    // describes bufferbloat, and the reason to graph them beside the throughput.
    {key: "downloadLatency", name: "Download latency", unit: "ms", deviceClass: "duration"},
    {key: "uploadLatency", name: "Upload latency", unit: "ms", deviceClass: "duration"}
];

/** What Home Assistant will take in an object id, and what a topic segment will. */
const UNUSABLE = /[^a-z0-9_-]+/g;

/** For a topic that reduces to nothing usable at all. */
const FALLBACK_ID = "myspeed";

/**
 * The device identity, derived from the state topic rather than configured.
 *
 * It has to be stable across restarts, because Home Assistant matches entities
 * by it, and distinct between two instances sharing a broker. The topic is
 * already both: it is a stored setting, and two instances publishing to the same
 * one would be overwriting each other's results long before their entity ids
 * mattered.
 *
 * Everything outside the allowed set is folded to an underscore - a slash most
 * of all, since it would end the topic segment early and put the rest of the id
 * where the word "config" belongs.
 */
export const deviceIdFrom = (stateTopic) => {
    const slug = String(stateTopic ?? "").toLowerCase().replace(UNUSABLE, "_").replace(/^_+|_+$/g, "");

    return slug === "" ? FALLBACK_ID : slug;
};

const NAME = "MySpeed";

/**
 * One retained config message per sensor.
 *
 * The device block is repeated on each rather than sent once: Home Assistant
 * groups entities by it, and a message that omits it is a loose entity rather
 * than part of the device.
 */
export const discoveryMessages = ({stateTopic, prefix = DEFAULT_DISCOVERY_PREFIX, version}) => {
    const deviceId = deviceIdFrom(stateTopic);

    const device = {
        identifiers: [deviceId],
        name: NAME,
        manufacturer: NAME,
        model: NAME,
        // Omitted rather than sent as null when unknown: a version field reading
        // "null" in the device panel is worse than one that is not shown.
        ...(version ? {sw_version: version} : {})
    };

    return SENSORS.map((sensor) => {
        const objectId = `${deviceId}_${sensor.key.toLowerCase()}`;

        return {
            topic: `${prefix}/sensor/${deviceId}/${sensor.key.toLowerCase()}/config`,
            retain: true,
            payload: JSON.stringify({
                name: sensor.name,
                // Unique to the entity and to the instance. Two instances share
                // the discovery prefix, so an id unique only within one would
                // have the second adopt the first one's entities.
                unique_id: objectId,
                object_id: objectId,
                state_topic: stateTopic,
                value_template: `{{ value_json.${sensor.key} }}`,
                unit_of_measurement: sensor.unit,
                // Omitted rather than nulled where there is none: a percentage
                // of lost packets is not one of the kinds Home Assistant knows,
                // and a null class is refused rather than ignored.
                ...(sensor.deviceClass ? {device_class: sensor.deviceClass} : {}),
                // Puts the sensor in the statistics engine, which is what makes
                // long-term history and the statistics card work at all.
                state_class: "measurement",
                device
            })
        };
    });
};

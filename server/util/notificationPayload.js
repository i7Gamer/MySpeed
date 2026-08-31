import { DATE_VARIABLES } from './helpers.js';
// The two names the alert gate reads as a decision, taken from there rather
// than spelled again: a chip the dialog offers must be a key the payload
// carries, and two literals are how those stop agreeing without anything
// failing to compile.
import { BASELINE_ARMED, BASELINE_BREACHED } from './alertThreshold.js';

/**
 * What an integration is told about a test, and what an operator may name in a
 * message template.
 *
 * A finished test used to be described by five numbers - ping, jitter, download,
 * upload and the duration - while the row written beside it already recorded
 * which provider ran the test, which server it reached, how the connection
 * looked from outside, what the run cost in traffic and how much was lost.
 * Upstream #1250 asks for that and #1049 for the server id in particular: a
 * webhook is how MySpeed feeds anything else, and a consumer that cannot tell
 * which provider or which server produced a number can do little with it.
 *
 * The keys are the column names, so the webhook, the CSV export and the API all
 * describe a test in the same vocabulary.
 *
 * Flat, deliberately. Every key becomes a %variable% a template may use, and a
 * nested object would substitute into a message as "[object Object]".
 */
const FINISHED_KEYS = [
    // Which test this was, and when.
    "id", "created",
    // What ran it.
    "provider",
    // What it measured.
    "ping", "jitter", "download", "upload", "time",
    "packetLoss", "downloadLatency", "uploadLatency",
    // What it measured against.
    "serverId", "serverName", "serverHost", "serverLocation",
    // What the connection was, as the provider saw it.
    "isp", "externalIp",
    // Where the provider's own report of this run can be read.
    "resultId",
    // What the run cost in traffic.
    "bytesDownloaded", "bytesUploaded",
    // Which round member measured it. Null on instances from before targets
    // existed; templates naming %targetName% read as unmeasured there.
    "targetId", "targetName",
    // Whether that member is the one the instance-wide surfaces speak for -
    // the first of the scheduled round. The MQTT module keeps the primary on
    // the base topic and routes the rest to subtopics on exactly this, because
    // the payload is the one thing a broker-side module can read without a
    // database. Null from an older node, which every reader treats as primary.
    "primary",
    // Whether that member takes part in alerting. The events leave for every
    // member - a data sink mirrors the stored history - and suppressesEvent
    // quiets the notifiers on exactly this flag. Null from an older node,
    // which the gate reads as alerting: how a single-target instance always
    // behaved.
    "alerts",
    // Whether this member's own baseline is armed, and whether this test fell
    // below it - the rolling 30-day median of the target's own successful runs,
    // judged in util/baselineAlert.js before the row was written. Null on every
    // target that set no baseline and from any older node, which the gate reads
    // as "no baseline", the way `alerts` reads absent as alerting.
    BASELINE_ARMED, BASELINE_BREACHED,
    // And the yardstick itself, so a message can say what this line usually
    // delivers beside what it just did. The percentage is not here: it is the
    // operator's own setting, on the screen they set it from, where these four
    // are facts about the run.
    "baselineDownload", "baselineUpload"
];

const FAILED_KEYS = ["id", "created", "provider", "error", "targetId", "targetName", "primary", "alerts"];

/**
 * A record reduced to exactly the advertised keys.
 *
 * Every key is present whether or not the record carried it: a template naming
 * a variable the provider did not report should read as unmeasured rather than
 * be left in the message as a literal "%isp%".
 */
const pick = (keys, record) =>
    Object.fromEntries(keys.map((key) => [key, record?.[key] ?? null]));

export const finishedPayload = (record) => pick(FINISHED_KEYS, record);

export const failedPayload = (record) => pick(FAILED_KEYS, record);

/**
 * The names the integration dialog offers for each kind of message.
 *
 * The clock variables come from replaceVariables rather than from the payload,
 * and are usable in either. Derived from the key lists above rather than
 * written out again, so a field added to the payload is offered without a
 * second edit - and one that is offered is guaranteed to substitute.
 */
export const FINISHED_VARIABLES = [...FINISHED_KEYS, ...DATE_VARIABLES];

export const FAILED_VARIABLES = [...FAILED_KEYS, ...DATE_VARIABLES];

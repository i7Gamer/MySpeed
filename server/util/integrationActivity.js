/**
 * Notes an integration's outcome against it, without letting that note matter.
 *
 * `activity` is triggerEvent's callback and it awaits an IntegrationData
 * update, so it returns a promise that can reject - a transient SQLITE_BUSY
 * while the speedtest row is being written to the same file is the realistic
 * case. It was invoked bare inside util/http.js, so the rejection had no
 * handler at all and escaped to the process-level unhandledRejection hook; the
 * two sibling calls in controller/integrations.js carry a deliberate catch that
 * this path did not.
 *
 * Whether the note was written is not something the send depends on, either way
 * round: a throw from the callback must not turn a delivered notification into
 * a reported failure.
 *
 * Its own module rather than a private function inside util/http.js, because
 * that is no longer the only way a notification leaves: the email integration
 * opens an SMTP connection and nothing about it goes through the HTTP helpers,
 * yet its outcome has to reach the integration card the same way. A second copy
 * of these seven lines would be the start of the two disagreeing about whether a
 * failed note is a failed send.
 */
export const noteActivity = (activity, failed) => {
    try {
        Promise.resolve(activity?.(failed)).catch(() => undefined);
    } catch {
        // A synchronous throw from the callback, which is no more the send's
        // business than a rejected one.
    }
};

/**
 * How long any one outbound send may take.
 *
 * Integrations are notified from inside the speedtest run, which holds the run
 * lock until every one of them has answered. A webhook pointed at a host that
 * accepts the connection and then says nothing would otherwise hang that run
 * forever, so every outbound send carries this deadline.
 *
 * getJson takes it only as the default for a caller that has no opinion. The run
 * lock says nothing about a GET, so a caller whose request is slower or more
 * expendable than a webhook is expected to name its own deadline instead.
 *
 * Shared for the same reason as the note above: the SMTP path has three separate
 * deadlines of its own - connection, greeting and socket - and they should be
 * the deadline every webhook already carries rather than a number written out
 * again beside them.
 */
export const OUTBOUND_TIMEOUT = 10000;

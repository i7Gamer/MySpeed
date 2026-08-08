import {t} from "i18next";
import {postRequest} from "@/common/utils/RequestUtil";
import {startBlockedReason, START_BLOCKED_PAUSED} from "@/common/utils/StatusUtil";

/**
 * Starts a speedtest on behalf of whichever control asked for one.
 *
 * The header gauge and the status bar both offer this, and each used to carry
 * its own copy - which is how two controls for the same action end up disagreeing
 * about when it is allowed.
 *
 * The status is refreshed first: the poll backs off while nothing is running, so
 * what the interface last heard can be several seconds stale by the time someone
 * clicks.
 */
export const startSpeedtest = async ({status, config, updateStatus, setRunning, updateTests, alert}) => {
    await updateStatus();

    const blocked = startBlockedReason(status, config);

    if (blocked === START_BLOCKED_PAUSED) {
        alert.openAlert(t("failed"), t("header.paused"), {buttonText: t("dialog.okay")});
        return;
    }

    // Already running, or not something this visitor may do - the server refuses
    // either way, so there is nothing to say.
    if (blocked !== null) return;

    setRunning(true);

    try {
        // fetch only rejects on network errors, so a 409/410 has to be read off
        // the response - otherwise a refused start looked like a success and
        // left the gauge spinning until the next status poll.
        const response = await postRequest("/speedtests/run");

        if (!response.ok) {
            setRunning(false);
            const body = await response.json().catch(() => null);
            alert.openAlert(t("failed"), body?.message ?? t("header.running"), {buttonText: t("dialog.okay")});
            return;
        }

        await updateTests();
    } catch (error) {
        setRunning(false);
        alert.openAlert(t("failed"), t("header.running"), {buttonText: t("dialog.okay")});
    } finally {
        await updateStatus();
    }
};

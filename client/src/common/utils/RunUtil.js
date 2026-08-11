import {t} from "i18next";
import {postRequest} from "@/common/utils/RequestUtil";

/**
 * Starts a speedtest on behalf of whichever control asked for one.
 *
 * The status is refreshed either side of the run - the poll backs off while
 * nothing is running, so what the interface last heard can be several seconds
 * stale by the time someone clicks, and the gauge has to catch up once the
 * request is away.
 *
 * There is deliberately no guard here on top of that. There used to be one, and
 * it could never fire: it re-read the `status` it was handed, a render-time
 * snapshot that the awaited refresh cannot change, and StartTestButton derives
 * its own `disabled` from that same snapshot - so by the time this ran, the
 * answer was already known to be "not blocked". The refusal that matters is the
 * server's, which is read off the response below.
 */
export const startSpeedtest = async ({updateStatus, setRunning, updateTests, alert}) => {
    await updateStatus();

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

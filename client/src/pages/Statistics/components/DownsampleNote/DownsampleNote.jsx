import "./styles.sass";
import { t } from "i18next";

/**
 * Tells the reader that a chart is showing bucket averages rather than one
 * point per test.
 *
 * The server reduces any range with more than a few hundred tests before it
 * reaches the client. Without this the reduction is invisible, and a smoothed
 * line looks like a genuinely steady connection.
 */
export const DownsampleNote = ({downsampled, shown, total}) => {
    if (!downsampled || !shown || !total) return null;

    return (
        <p className="chart-downsample-note">
            {t("statistics.downsampled", {
                shown: shown.toLocaleString(),
                total: total.toLocaleString()
            })}
        </p>
    );
};

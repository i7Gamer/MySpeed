import {t} from "i18next";

/**
 * What each measurement means.
 *
 * These lived on the latest-test panel on the overview, which the status bar
 * replaced. They are reached from the metric icons now - on every test row, and
 * on the detail pane that row opens - so the explanations sit next to every
 * reading rather than next to only the newest.
 *
 * Read at call time rather than built once: `t` resolves against the language
 * loaded right now, and a module-level object would freeze whichever one
 * happened to be active when this file was first imported.
 */

export const downloadInfo = () => ({title: t("info.down.title"), description: t("info.down.description"), buttonText: t("dialog.okay")});

export const pingInfo = () => ({title: t("info.ping.title"), description: t("info.ping.description"), buttonText: t("dialog.okay")});

export const jitterInfo = () => ({title: t("info.jitter.title"), description: t("info.jitter.description"), buttonText: t("dialog.okay")});

export const uploadInfo = () => ({title: t("info.up.title"), description: t("info.up.description"), buttonText: t("dialog.okay")});

// Only the detail pane shows one, and only Ookla measures one - which is why it
// is the figure most in need of a sentence saying what it is.
export const packetLossInfo = () => ({title: t("info.packet_loss.title"), description: t("info.packet_loss.description"), buttonText: t("dialog.okay")});

// The two halves of what the line does while it is busy: the latency each
// direction showed under load, and the grade for the worse of them.
export const loadedLatencyInfo = () => ({title: t("info.loaded_latency.title"), description: t("info.loaded_latency.description"), buttonText: t("dialog.okay")});

export const bufferbloatInfo = () => ({title: t("info.bufferbloat.title"), description: t("info.bufferbloat.description"), buttonText: t("dialog.okay")});

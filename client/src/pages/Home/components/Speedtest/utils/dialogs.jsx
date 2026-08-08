import {t} from "i18next";

/**
 * What each measurement means.
 *
 * These lived on the latest-test panel on the overview, which the status bar
 * replaced. They are reached from the metric icons on each test row now, so the
 * explanations sit next to every reading rather than next to only the newest.
 */

export const downloadInfo = () => ({title: t("info.down.title"), description: t("info.down.description"), buttonText: t("dialog.okay")});

export const pingInfo = () => ({title: t("info.ping.title"), description: t("info.ping.description"), buttonText: t("dialog.okay")});

export const jitterInfo = () => ({title: t("info.jitter.title"), description: t("info.jitter.description"), buttonText: t("dialog.okay")});

export const uploadInfo = () => ({title: t("info.up.title"), description: t("info.up.description"), buttonText: t("dialog.okay")});
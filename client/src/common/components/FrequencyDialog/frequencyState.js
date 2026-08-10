export const DEFAULT_CRON = "0 * * * *";

// The choices the dialog offers, without their icons: the icons are the
// dialog's clothing, and this module has to stay importable by node tests.
export const CRON_PRESETS = [
    {id: "continuous", cron: "* * * * *"},
    {id: "frequent", cron: "0,30 * * * *"},
    {id: "default", cron: DEFAULT_CRON},
    {id: "rare", cron: "0 0,3,6,9,12,15,18,21 * * *"},
    {id: "really_rare", cron: "0 0,6,12,18 * * *"}
];

/**
 * What the dialog shows for a stored configuration.
 *
 * Pure, because showing something else is exactly the bug this replaces: the
 * dialog used to capture the config once at mount, and on an instance with
 * read-level access that was the visitor config - which omits cron and
 * scheduleOffset entirely. The defaults this degrades to for an empty config
 * are what an operator then saw over their stored settings.
 */
export const frequencyStateFrom = (config) => {
    const preset = CRON_PRESETS.find((candidate) => candidate.cron === config.cron);

    return {
        selected: preset ? preset.id : "custom",
        customCron: config.cron || DEFAULT_CRON,
        scheduleOffset: config.scheduleOffset === "true",
        showAdvanced: !preset
    };
};

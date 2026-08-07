import i18n, {t} from "i18next";
import {SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H} from "@/common/contexts/Preferences";

// Passing undefined means "whatever locale the browser is set to", which
// ignores the language the user picked in the app - a German UI rendered
// English month names and a 12-hour clock on an en-US browser.
const locale = () => i18n.language || undefined;

const toDate = (value) => {
    if (value instanceof Date) return value;
    return new Date(value);
};

export const formatTime = (value, preferences) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    return date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12h
    });
};

export const formatDateTime = (value, preferences, dateOptions = {}) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    const datePart = date.toLocaleDateString(locale(), dateOptions);
    const timePart = date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12h
    });
    return `${datePart} ${timePart}`;
};

export const formatShortTime = (date, preferences) => {
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    if (use12h) {
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const suffix = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        if (hours === 0) hours = 12;
        return `${hours}:${minutes} ${suffix}`;
    }
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
};

export const getSpeedUnit = (preferences) => {
    if (preferences?.speedUnit === SPEED_UNIT_MBYTES) {
        return t("latest.byte_speed_unit", {defaultValue: "MB/s"});
    }
    return t("latest.speed_unit");
};

export const convertSpeed = (mbps, preferences) => {
    if (mbps === null || mbps === undefined) return mbps;
    if (typeof mbps !== "number" || isNaN(mbps)) return mbps;
    if (mbps < 0) return mbps;

    if (preferences?.speedUnit === SPEED_UNIT_MBYTES) {
        return Math.round((mbps / 8) * 100) / 100;
    }
    return mbps;
};

export {SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H};

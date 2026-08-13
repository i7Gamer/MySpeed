import {useAlert} from "@/common/contexts/Alert";

/**
 * Opens the explanation behind a metric icon.
 *
 * The click is stopped because every place these icons appear sits inside
 * something clickable of its own - the overview row expands, the chart modal
 * closes - and asking what a measurement is should not also do that.
 *
 * The info is passed as a function rather than an object so its strings are
 * resolved at click time, in whatever language is loaded then.
 */
export const useMetricInfo = () => {
    const alert = useAlert();

    return (event, info) => {
        event.stopPropagation();

        const {title, description, buttonText} = info();
        alert.openAlert(title, description, {buttonText});
    };
};

import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faExclamationTriangle} from "@fortawesome/free-solid-svg-icons";
import {useEffect, useState} from "react";
import "./styles.sass";

export const Error = (props) => {
    const [reloadTimer, setReloadTimer] = useState(5);

    // One interval for the whole countdown. With the counter in the dependency
    // list every tick tore the interval down and built a new one - five timers
    // for one countdown, and any unrelated re-render mid-second reset the very
    // timer it was supposedly reading, stretching the wait.
    useEffect(() => {
        if (props.disableReload) return;

        const interval = setInterval(() =>
            setReloadTimer((prev) => prev > 0 ? prev - 1 : prev), 1000);

        return () => clearInterval(interval);
    }, [props.disableReload]);

    // The reload is its own effect, so the tick stays a pure count. The one
    // second of delay is the second of "Reloading now..." the countdown has
    // always shown before going.
    useEffect(() => {
        if (props.disableReload || reloadTimer !== 0) return;

        const reload = setTimeout(() => { window.location = window.location.href; }, 1000);

        return () => clearTimeout(reload);
    }, [reloadTimer, props.disableReload]);

    return (
        <div className={"error-page" + (props.disableReload ? " no-reload" : "")}>
            <FontAwesomeIcon icon={faExclamationTriangle} size="8x"/>
            <h1>{props.text}</h1>
            {!props.disableReload && <h2>Reloading {reloadTimer !== 0 ? <>in <span>{reloadTimer}</span> seconds</> :
                <span>now</span>}...</h2>}
        </div>
    )
}
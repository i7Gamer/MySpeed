import React from "react";
import {Trans} from "react-i18next";
import {t} from "i18next";

const RESULT_URL = "https://www.speedtest.net/result/c/";

export const averageResultDialog = (timeString, props) => <Trans components={{Bold: <span className="dialog-value"/> }}
                                                                 values={{amount: props.amount, date: timeString, down: props.down,
                                                                     up: props.up, duration: props.duration}}>test.average.description</Trans>

export const resultDialog = (props) => <>
    <Trans components={{Bold: <span className="dialog-value"/>,
        Link: (props.resultId ? <a href={RESULT_URL + props.resultId} target="_blank" rel="noreferrer"/> : <span/>) }}
                                              values={{down: props.down, up: props.up,
                                                  type: t("test.result." + (props.type === "custom" ? "from_you" : "automatic")),
                                                  duration: props.duration}}>test.result.description</Trans>
    {props.jitter !== null && props.jitter !== undefined && (
        <Trans components={{Bold: <span className="dialog-value"/>}}
               values={{jitter: props.jitter}}>test.result.jitter</Trans>
    )}
    {/* The host is the fallback: it is always set when a name is not, and is
        still more useful than saying nothing about which server was measured. */}
    {(props.serverName || props.serverHost) && (
        <Trans components={{Bold: <span className="dialog-value"/>}}
               values={{server: props.serverName || props.serverHost}}>test.result.server</Trans>
    )}
</>;
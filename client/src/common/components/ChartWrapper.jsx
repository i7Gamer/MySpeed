import {useRef, useEffect, useState} from "react";
import {Chart} from "chart.js";
import {useTranslation} from "react-i18next";
import "../utils/chartConfig";

// Callers supply their translated chart title. The fallback protects an
// invalid caller without crashing chart drawing or exposing an unnamed image.
export default function ChartWrapper({type, data, options, accessibleName}) {
    const {t} = useTranslation();
    const name = typeof accessibleName === "string" && accessibleName.trim()
        ? accessibleName : t("page.statistics");
    const canvasRef = useRef(null);
    const chartRef = useRef(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setReady(true), 0);
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        if (!ready || !canvasRef.current) return;
        if (!chartRef.current) {
            chartRef.current = new Chart(canvasRef.current, {type, data, options});
        } else {
            chartRef.current.data = data;
            chartRef.current.options = options;
            chartRef.current.update("none");
        }
    }, [ready, type, data, options]);

    useEffect(() => () => {
        chartRef.current?.destroy();
        chartRef.current = null;
    }, []);

    return <canvas ref={canvasRef} role="img" aria-label={name}/>;
}

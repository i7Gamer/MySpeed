import "./styles.sass";
import BorderAnimation from "@/common/components/BorderAnimation";
import {clickable} from "@/common/utils/Clickable";

export const StatisticContainer = (props) => {
    const showAnimation = props.running && !props.expanded;

    return (
        // Five of the nine tiles on the page are this component, and opening one
        // is the only way to the expanded panel behind it - so it has to be
        // reachable by something other than a pointer. Not a <button>: it holds
        // a heading and a whole panel, which a button may not contain.
        <div className={"stats-container" + (props.size ? " container-" + props.size : "") + (showAnimation ? " container-running" : "")} {...clickable(props.onClick)}>
            {showAnimation && <BorderAnimation />}
            <div className="stats-header">
                {props.title}
            </div>
            <div className={"stats-content " + (props.center ?" container-center" : "")}>
                {props.children}
            </div>
        </div>
    );
}
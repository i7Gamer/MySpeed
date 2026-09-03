import "./styles.sass";
import {withBasePath} from "@/common/utils/BasePath";

export const NodeHeader = () => {
    return (
        <div className="node-header">
            {/* Decorative, as in the page header: the name is the heading
                beside it. */}
            <img src={withBasePath("/assets/img/logo192.png")} alt=""/>
            <h1>MySpeed</h1>
        </div>
    )
}
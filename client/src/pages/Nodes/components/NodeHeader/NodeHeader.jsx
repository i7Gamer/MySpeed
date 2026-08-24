import "./styles.sass";
import {withBasePath} from "@/common/utils/BasePath";

export const NodeHeader = () => {
    return (
        <div className="node-header">
            <img src={withBasePath("/assets/img/logo192.png")} alt="Logo"/>
            <h1>MySpeed</h1>
        </div>
    )
}
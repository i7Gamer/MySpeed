import React, {useState, createContext, useEffect, useContext} from "react";
import {baseRequest} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {LOCAL_NODE, selectedNode} from "@/common/contexts/Node/nodeSelection";

export const NodeContext = createContext({});

export const NodeProvider = (props) => {

    const [config, reloadConfig] = useContext(ConfigContext);
    const [nodes, setNodes] = useState([]);
    // Whether the list above is an answer or merely the value it starts at. The
    // reconciliation below cannot tell those apart on its own, and treating the
    // second as the first would move every session to this instance on load.
    const [nodesLoaded, setNodesLoaded] = useState(false);
    const [currentNode, setCurrentNode] = useState(parseInt(localStorage.getItem("currentNode")) || LOCAL_NODE);

    const updateNodes = async () => baseRequest("/nodes").then(async nodes => {
        if (nodes.ok) {
            setNodes(await nodes.json());
            setNodesLoaded(true);
        }
    });

    useEffect(() => {
        if (Object.keys(config).length === 0) return;
        if (!config.viewMode) updateNodes();
    }, [config]);

    const updateCurrentNode = (node) => {
        localStorage.setItem("currentNode", node);
        setCurrentNode(parseInt(node));
    }

    /**
     * The selection, against the nodes that actually exist.
     *
     * Nothing did this, so deleting the node you were looking at left every
     * request in the app aimed at it - RequestUtil builds its root from this
     * value and handleDelete only refreshed the list. It was not visible on the
     * node page, which uses the fixed baseRequest throughout, so it surfaced on
     * the next navigation as a dashboard talking to a node that is gone.
     *
     * Here rather than in the delete handler because the delete is not the only
     * way in: a node removed from another browser, or a config restored from a
     * backup older than it, leaves the same stale id behind.
     *
     * The config goes with it. It was read from the node that has been dropped,
     * and the thresholds every figure is graded against are in it.
     */
    useEffect(() => {
        const selected = selectedNode(currentNode, nodes, nodesLoaded);
        if (selected === currentNode) return;

        updateCurrentNode(selected);
        reloadConfig();
        // updateCurrentNode and reloadConfig are rebuilt on every render;
        // listing them would run this on each one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, nodesLoaded, currentNode]);

    const findNode = (nodeId) => nodes?.find(node => node.id === nodeId);

    return (
        <NodeContext.Provider value={[nodes, updateNodes, currentNode, updateCurrentNode, findNode]}>
            {props.children}
        </NodeContext.Provider>
    )
}
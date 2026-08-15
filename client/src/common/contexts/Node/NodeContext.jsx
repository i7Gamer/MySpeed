import React, {useState, createContext, useEffect, useContext, useRef} from "react";
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

    /*
     * Only the newest request is allowed to settle - the same discipline
     * SpeedtestContext keeps, and for a sharper reason since the reconciliation
     * below landed. reloadConfig gives `config` a new identity on every call,
     * from a dozen places, and each one re-runs the effect that calls this; two
     * fetches can therefore be in flight at once. Before, an out-of-order
     * answer only redrew the card list. Now the list decides which node the
     * whole app talks to, so a stale one that happens to arrive last would move
     * the session to this instance and write that to localStorage.
     */
    const requestGeneration = useRef(0);

    const updateNodes = async () => {
        const generation = ++requestGeneration.current;

        return baseRequest("/nodes").then(async nodes => {
            if (!nodes.ok) return;

            const fetched = await nodes.json();
            if (generation !== requestGeneration.current) return;

            setNodes(fetched);
            setNodesLoaded(true);
        });
    };

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
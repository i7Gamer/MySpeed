import React, {useState, createContext, useEffect, useContext, useRef} from "react";
import {baseRequest} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {LOCAL_NODE, selectedNode} from "@/common/contexts/Node/nodeSelection";
import {readStored, writeStored} from "@/common/utils/Storage";

export const NodeContext = createContext({});

export const NodeProvider = (props) => {

    const [config, reloadConfig] = useContext(ConfigContext);
    const [nodes, setNodes] = useState([]);
    // Whether the list above is an answer or merely the value it starts at. The
    // reconciliation below cannot tell those apart on its own, and treating the
    // second as the first would move every session to this instance on load.
    const [nodesLoaded, setNodesLoaded] = useState(false);
    const [currentNode, setCurrentNode] = useState(parseInt(readStored("currentNode")) || LOCAL_NODE);

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

    /*
     * The newest answer *applied*, not the newest request issued.
     *
     * Comparing against the issued counter made a failing request destructive:
     * a later fetch that came back 401 or 500 returned without applying
     * anything, but had already claimed the newest generation - so an earlier
     * successful response arriving behind it was discarded and the list stayed
     * empty. Recording what was applied lets a good answer through whenever
     * nothing newer has superseded it, while a stale one is still dropped.
     */
    const appliedGeneration = useRef(0);

    const updateNodes = async () => {
        const generation = ++requestGeneration.current;

        return baseRequest("/nodes").then(async nodes => {
            if (!nodes.ok) return;

            const fetched = await nodes.json();
            if (generation <= appliedGeneration.current) return;

            appliedGeneration.current = generation;
            setNodes(fetched);
            setNodesLoaded(true);
        });
    };

    /**
     * Whether the config is an answer at all, rather than the value it starts
     * at.
     *
     * Kept apart from what the answer *says*, and depended on separately below,
     * because the two are not derivable from one another: `config` here is
     * whichever instance the app is pointed at, and a node running a version
     * from before the flag existed answers without a viewMode at all. Reading
     * that absence as "not loaded yet" would leave the node list permanently
     * empty against such a node.
     */
    const configLoaded = Object.keys(config).length > 0;

    /**
     * Keyed on the two things this reads rather than on the config object.
     *
     * reloadConfig gives `config` a new identity on every call, from a dozen
     * places - so every settings save, password change and node edit refetched
     * a list none of them had changed, and could put two fetches in flight at
     * once. That is the race the generation refs above exist to survive, and
     * this effect was manufacturing it. They stay, because the dialogs call
     * updateNodes directly too; what goes is the effect firing on a config that
     * says exactly what it said before.
     *
     * viewMode is still a dependency, and has to be: the nodes route answers a
     * read-only reader with an empty list, so signing in through the header is
     * what makes the nodes appear without a page reload.
     */
    useEffect(() => {
        if (!configLoaded) return;
        if (!config.viewMode) updateNodes();
    }, [configLoaded, config.viewMode]);

    const updateCurrentNode = (node) => {
        writeStored("currentNode", node);
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
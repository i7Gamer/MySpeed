import {useEffect, useRef} from "react";

/**
 * Runs `sync` at the moment a dialog opens.
 *
 * The settings dialogs are mounted with the header, long before they are
 * opened, and used to seed their state from the config in useState
 * initialisers - run once, at that mount. On an instance with read-level
 * access the header first mounts against the visitor config, which omits the
 * very keys those dialogs edit; logging in replaces the config, but an
 * initialiser never runs twice. The dialog then shows defaults over the
 * stored values, and whatever the operator re-saves in disbelief is what
 * actually changes them.
 *
 * Opening is the honest moment to read: every open shows what is stored right
 * now, and nothing stomps the operator's edits while the dialog is in use.
 *
 * The ref keeps the effect keyed on `open` alone while the sync it fires
 * still reads the context current at open time - without it the effect would
 * capture its first closure, which is the very disease this hook cures.
 */
export const useSyncOnOpen = (open, sync) => {
    const syncRef = useRef(sync);
    syncRef.current = sync;

    useEffect(() => {
        if (open) syncRef.current();
    }, [open]);
};

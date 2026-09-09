import {useLayoutEffect, useMemo} from "react";

/** Own asynchronous work for one opening on one instance. Loads also claim a
 * generation so an older response cannot overwrite a mutation's refresh. */
export const useDialogSession = (open, scope) => {
    const session = useMemo(() => ({active: open, scope, generation: 0}), [open, scope]);
    useLayoutEffect(() => {
        session.active = open;
        return () => { session.active = false; };
    }, [open, session]);
    return session;
};

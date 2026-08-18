import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faClose} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {isTopmostOverlay} from "@/common/contexts/Dialog";
import {useModalFocus} from "@/common/hooks/useModalFocus";

const AlertContext = createContext(null);

export const useAlert = () => {
    const context = useContext(AlertContext);
    if (!context) throw new Error("useAlert must be used within AlertProvider");
    return context;
};

export const AlertProvider = ({children}) => {
    const [alerts, setAlerts] = useState([]);
    const alertIdRef = useRef(0);
    const resolversRef = useRef(new Map());

    const showAlert = useCallback((config) => {
        return new Promise((resolve) => {
            const id = ++alertIdRef.current;
            resolversRef.current.set(id, resolve);
            // Recorded here rather than read when the overlay mounts: focus is
            // moved into the alert during commit - autoFocus on the input
            // variant - so by the time a passive effect looks, the answer is
            // the alert's own field, and giving focus back would mean giving it
            // to an element that has just been unmounted.
            setAlerts(prev => [...prev, {...config, id, openedFrom: document.activeElement}]);
        });
    }, []);

    const closeAlert = useCallback((id, result = null) => {
        const resolver = resolversRef.current.get(id);
        if (resolver) {
            resolver(result);
            resolversRef.current.delete(id);
        }
        setAlerts(prev => prev.filter(a => a.id !== id));
    }, []);

    const openAlert = useCallback((title, description, options = {}) =>
        showAlert({
            type: "alert",
            title,
            description,
            buttonText: options.buttonText || "OK", ...options
        }), [showAlert]);

    const openInput = useCallback((title, options = {}) =>
        showAlert({type: "input", title, ...options}), [showAlert]);

    const openSelect = useCallback((title, selectOptions, options = {}) =>
        showAlert({
            type: "select",
            title,
            options: selectOptions,
            value: options.value || Object.keys(selectOptions)[0], ...options
        }), [showAlert]);

    const openConfirm = useCallback((title, description, options = {}) =>
        showAlert({
            type: "confirm",
            title,
            description,
            buttonText: options.buttonText || "OK", ...options
        }), [showAlert]);

    const contextValue = useMemo(() => ({
        openAlert, openInput, openSelect, openConfirm
    }), [openAlert, openInput, openSelect, openConfirm]);

    return (
        <AlertContext.Provider value={contextValue}>
            {children}
            {/* Only the last-opened alert is "on top": alerts stack, and the
                keyboard must reach exactly one of them. */}
            {alerts.map((alert, index) => (
                <AlertRenderer key={alert.id} alert={alert} isTop={index === alerts.length - 1}
                               onClose={(result) => closeAlert(alert.id, result)}/>
            ))}
        </AlertContext.Provider>
    );
};

const AlertRenderer = ({alert, isTop, onClose}) => {
    const areaRef = useRef();
    const dialogRef = useRef();
    const [inputValue, setInputValue] = useState(alert.value || "");
    const [inputError, setInputError] = useState(false);
    const closeResultRef = useRef(null);
    const isClosingRef = useRef(false);

    const submitRef = useRef();

    /*
     * Only the alert on top takes focus. A stacked one below it has given up its
     * turn, and pulling focus back into it would fight the one above.
     *
     * On the primary button, not on whatever comes first in the markup. The
     * close X is the first thing in the header, and Enter on it resolves the
     * alert with null - the document handler declines a key aimed at a button
     * inside the alert, so the browser turns Enter into a click on whatever has
     * focus. Seated on the X, a confirmation answered Enter by cancelling.
     */
    useModalFocus(dialogRef, {
        // Mounted means open: this renderer only exists while its alert does.
        // Holding focus is the narrower state - an alert stacked over has given
        // up its turn, and giving focus back to the page while the one above is
        // taking it scrolls the page under two backdrops.
        open: true,
        holdsFocus: isTop,
        initialFocus: submitRef,
        restoreTo: alert.openedFrom
    });

    const close = useCallback((result = null) => {
        if (alert.disableClose && result === null) return;
        if (isClosingRef.current) return;
        isClosingRef.current = true;
        closeResultRef.current = result;
        areaRef.current?.classList.add("dialog-area-hidden");
        dialogRef.current?.classList.add("dialog-hidden");
    }, [alert.disableClose]);

    const handleAnimationEnd = (e) => {
        if (e.animationName === "fadeOut") onClose(closeResultRef.current);
    };

    const handleBackdropClick = (e) => {
        if (e.target === areaRef.current) close();
    };

    const handleKeyDown = useCallback((e) => {
        // Already answered by the overlay that heard it first - see the Dialog's
        // handler for why the backdrop rule needs this alongside it.
        if (e.defaultPrevented) return;

        // isTop settles which of the stacked alerts listens, but a Dialog is
        // listening on the same document too and cannot be silenced from here -
        // so the alert answers only while it is the overlay on top of it.
        if (!isTopmostOverlay(areaRef.current)) return;

        if (e.key === "Escape" && !alert.disableClose) {
            e.preventDefault();
            close();
        }
        if (e.key === "Enter") {
            // Enter belongs to whatever button has focus - the browser turns it
            // into a click on that one. Claiming it here submitted the alert
            // instead, and the preventDefault below suppressed the click that
            // would have cancelled, so tabbing to Cancel and pressing Enter ran
            // the very action Cancel refuses. On the destructive confirmations -
            // "delete all tests", "remove the password" - that is the whole of
            // the damage.
            //
            // e.target is the focused element: this listener sits on the
            // document and the key bubbles up from wherever it was pressed. The
            // input an alert focuses on open is not a button, so the shortcut
            // that makes an alert usable without tabbing to OK is untouched.
            //
            // Only the alert's *own* buttons, which is what areaRef answers.
            // Bailing out for any focused button anywhere was the wrong rule in
            // the other direction: declining the key on a page button does not
            // hand it to Cancel, it hands it to the browser, which turns an
            // unclaimed Enter on a focused button into a click - so the trigger
            // pushed a second copy of the alert being answered. Enter then never
            // dismissed an alert at all; holding it stacked them.
            //
            // That case is now unreachable, and the rule stays anyway. The alert
            // takes focus when it opens - onto its primary button, or onto the
            // input it autofocuses - so a focused button outside the alert is no
            // longer a state this can be in. What the guard is *for* now is the
            // first clause above: Enter on Cancel, or on the close X, belongs to
            // that control and not to handleSubmit. Seating focus on the X
            // rather than the primary button is exactly how a confirmation came
            // to answer Enter by cancelling - see initialFocus above.
            if (e.target?.tagName === "BUTTON" && areaRef.current?.contains(e.target)) return;

            e.preventDefault();
            handleSubmit();
        }
        // `close` and `handleSubmit` are rebuilt on every render, so listing
        // them would give this callback a new identity every time and the
        // listener below would be swapped on each one. Everything they read -
        // the alert and the input's value - is already a dependency here, so
        // there is no closure to go stale.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [alert, inputValue]);

    useEffect(() => {
        // The listener sits on the document, so every stacked alert used to
        // hear the same Enter: one keypress submitted them all, the hidden
        // ones resolving with whatever their inputs happened to hold.
        if (!isTop) return;

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown, isTop]);

    const handleSubmit = () => {
        if (alert.type === "input" && alert.required && !inputValue) {
            setInputError(true);
            return;
        }
        const result = alert.type === "input" || alert.type === "select" ? inputValue : true;
        alert.onSuccess?.(result);
        close(result);
    };

    return createPortal(
        <div className="dialog-area" ref={areaRef} onClick={handleBackdropClick}>
            {/* Named by its own title, which the alert has to hand - the Dialog
                beside it has to wire an id instead, because its heading is
                written by whoever renders the header. */}
            <div className="dialog" ref={dialogRef} onAnimationEnd={handleAnimationEnd}
                 role="dialog" aria-modal="true" aria-label={alert.title} tabIndex={-1}>
                <div className="dialog-header">
                    <h4 className="dialog-text">{alert.title}</h4>
                    {/* A button, not the glyph on its own: FontAwesome renders
                        its svg aria-hidden and an svg is not in the tab order,
                        so this announced as nothing and could not be reached. */}
                    {!alert.disableClose && (
                        <button type="button" className="dialog-icon-button" data-overlay-dismiss
                                aria-label={t("dialog.close")} onClick={() => close()}>
                            <FontAwesomeIcon icon={faClose} className="dialog-text dialog-icon"/>
                        </button>
                    )}
                </div>
                <div className="dialog-main">
                    {alert.description && <p className="dialog-description">{alert.description}</p>}
                    {alert.type === "input" && (
                        <input className={`dialog-input${inputError ? " input-error" : ""}`}
                               type={alert.inputType || "text"}
                               placeholder={alert.placeholder} value={inputValue} autoFocus
                               onChange={(e) => {
                                   setInputValue(e.target.value);
                                   setInputError(false);
                               }}/>
                    )}
                    {alert.type === "select" && (
                        <select className="dialog-input" value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}>
                            {Object.entries(alert.options || {}).map(([key, label]) => (
                                <option key={key} value={key}>{label}</option>
                            ))}
                        </select>
                    )}
                </div>
                <div className="dialog-buttons">
                    {alert.clearButton && (
                        <button type="button" className="dialog-btn dialog-secondary" onClick={() => {
                            alert.onClear?.();
                            close();
                        }}>
                            {alert.clearButton}
                        </button>
                    )}
                    {alert.type === "confirm" && (
                        <button type="button" className="dialog-btn dialog-secondary" onClick={() => close(false)}>
                            {alert.cancelText || "Cancel"}
                        </button>
                    )}
                    <button type="button" ref={submitRef} className={`dialog-btn${alert.danger ? " dialog-danger" : ""}`}
                            onClick={handleSubmit}>
                        {alert.buttonText || "OK"}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

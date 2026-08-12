import React, {createContext, useEffect, useRef, useState} from "react";
import {faExclamationTriangle} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {toastClassName} from "@/common/contexts/ToastNotification/toastState";

export const ToastNotificationContext = createContext({});

// How long a toast stays up before it dismisses itself.
const TOAST_DURATION = 5000;

export const ToastNotificationProvider = (props) => {

    const [toastNotification, setToastNotification] = useState(null);
    const [visible, setVisible] = useState(false);

    /**
     * The pending dismissal, in a ref rather than in state.
     *
     * updateToast closed over whatever value its own render had, so two toasts
     * raised in the same tick left the first timer running - and it went on to
     * close the second one early, after however much of its five seconds was
     * left. A ref is read at call time, which is when the answer is wanted.
     */
    const dismissal = useRef(null);

    const clearDismissal = () => {
        if (dismissal.current === null) return;

        clearTimeout(dismissal.current);
        dismissal.current = null;
    };

    const close = () => setVisible(false);

    const updateToast = (text, color = "red", icon = faExclamationTriangle) => {
        setToastNotification({text, color, icon});
        setVisible(true);

        clearDismissal();
        dismissal.current = setTimeout(close, TOAST_DURATION);
    };

    // Nothing used to cancel this, so a timer outliving the provider closed
    // over setState functions for a tree that was gone.
    useEffect(() => clearDismissal, []);

    /**
     * The element is emptied only once it has finished animating out, so the
     * text does not vanish mid-slide. Visibility itself is state - it used to
     * be a classList.add() straight onto the live node, which React then
     * refused to overwrite because the className it computed was unchanged from
     * the one it last rendered. The next toast fired, the state was correct,
     * and nothing appeared on screen.
     */
    const onAnimationEnd = (event) => {
        if (event.animationName === "moveOut" && !visible) setToastNotification(null);
    };

    return (
        <ToastNotificationContext.Provider value={updateToast}>
            <div className={toastClassName(toastNotification, visible)}
                 onAnimationEnd={onAnimationEnd} onClick={close}>
                {toastNotification && <div className="toast-content">
                    <FontAwesomeIcon icon={toastNotification.icon} />
                    <h2>{toastNotification.text}</h2>
                </div>}
            </div>

            {props.children}
        </ToastNotificationContext.Provider>
    );
}

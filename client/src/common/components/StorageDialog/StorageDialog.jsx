import "./styles.sass";
import React, {useEffect, useId, useState} from "react";
import {Dialog, DialogHeader, DialogBody} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faDatabase, faGauge, faScrewdriverWrench} from "@fortawesome/free-solid-svg-icons";
import Speedtests from "./tabs/Speedtests";
import Configuration from "./tabs/Configuration";
import {jsonRequest} from "@/common/utils/RequestUtil";

const EMPTY_STORAGE = {size: 0, testCount: 0};

// The two halves of the dialog, in the order the arrows walk them.
const TABS = [
    {id: 1, icon: faGauge, labelKey: "storage.speedtests"},
    {id: 2, icon: faScrewdriverWrench, labelKey: "storage.configuration"}
];

// Both axes, because the tablist is a column on a desktop and a row on a
// narrow viewport - the arrows should work however it happens to be laid out.
const TAB_STEPS = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1};

export const StorageDialog = ({open, onClose}) => {
    const [storageSize, setStorageSize] = useState(EMPTY_STORAGE);
    const [currentTab, setCurrentTab] = useState(TABS[0].id);
    const tablistId = useId();

    // Falls back to the zeroed shape rather than null: the render below reads
    // .size and .testCount unconditionally, so storing null turned a failed
    // /storage request into a TypeError during render, which unmounts the whole
    // React tree - the entire app went blank, not just this dialog.
    useEffect(() => {
        if (!open) return;
        jsonRequest("/storage").then(setStorageSize).catch(() => setStorageSize(EMPTY_STORAGE));
    }, [open]);

    const tabId = (id) => `${tablistId}-tab-${id}`;

    /**
     * Selection follows focus, the way the ARIA tabs pattern reads: an arrow
     * lands on the other tab and shows its panel in the same stroke. Focus is
     * moved by hand because the roving tabindex below takes the unselected tab
     * out of the browser's own order - which is the point: Tab crosses the
     * tablist in one step, the arrows walk within it.
     */
    const moveTab = (event) => {
        const step = TAB_STEPS[event.key];
        const jump = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
        if (step === undefined && jump === null) return;

        event.preventDefault();
        const at = TABS.findIndex((tab) => tab.id === currentTab);
        const next = step === undefined ? jump : (at + step + TABS.length) % TABS.length;

        setCurrentTab(TABS[next].id);
        event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
    };

    return (
        <Dialog open={open} onClose={onClose} className="storage-dialog-wrapper">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("dropdown.storage")}</DialogHeader>
                    <DialogBody>
                        <div className="storage-dialog">
                            <div className="storage-options">
                                {/* Buttons in a tablist, not divs with an
                                    onClick: Tab walked straight past the divs
                                    and Enter did nothing there, so the
                                    configuration half of this dialog - factory
                                    reset included - did not exist for a
                                    keyboard. Spans inside, because a <p> may
                                    not sit in a button - the pagination
                                    documents the same trap. */}
                                <div className="storage-top" role="tablist" onKeyDown={moveTab}>
                                    {TABS.map((tab) => (
                                        <button type="button" key={tab.id} role="tab" id={tabId(tab.id)}
                                                className={"storage-tab" + (tab.id === currentTab ? " storage-item-active" : "")}
                                                aria-selected={tab.id === currentTab}
                                                aria-controls={`${tablistId}-panel`}
                                                tabIndex={tab.id === currentTab ? 0 : -1}
                                                onClick={() => setCurrentTab(tab.id)}>
                                            <FontAwesomeIcon icon={tab.icon}/>
                                            <span>{t(tab.labelKey)}</span>
                                        </button>
                                    ))}
                                </div>
                                <div className="storage-bottom">
                                    <div className="storage-tab reset-cursor">
                                        <FontAwesomeIcon icon={faDatabase}/>
                                        <p>{Math.round((storageSize?.size ?? 0) / 1024)} KB</p>
                                    </div>
                                </div>
                            </div>
                            <div className="storage-manager" role="tabpanel"
                                 id={`${tablistId}-panel`} aria-labelledby={tabId(currentTab)}>
                                {currentTab === TABS[0].id && <Speedtests tests={storageSize?.testCount ?? 0} close={close}/>}
                                {currentTab === TABS[1].id && <Configuration close={close}/>}
                            </div>
                        </div>
                    </DialogBody>
                </>
            )}
        </Dialog>
    );
}
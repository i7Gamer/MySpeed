import "./styles.sass";
import React, {useEffect, useState} from "react";
import {Dialog, DialogHeader, DialogBody} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faDatabase, faGauge, faScrewdriverWrench} from "@fortawesome/free-solid-svg-icons";
import Speedtests from "./tabs/Speedtests";
import Configuration from "./tabs/Configuration";
import {jsonRequest} from "@/common/utils/RequestUtil";

export const StorageDialog = ({open, onClose}) => {
    const [storageSize, setStorageSize] = useState({size: 0, testCount: 0});
    const [currentTab, setCurrentTab] = useState(1);

    useEffect(() => {
        if (!open) return;
        jsonRequest("/storage").then(setStorageSize).catch(() => setStorageSize(null));
    }, [open]);

    return (
        <Dialog open={open} onClose={onClose} className="storage-dialog-wrapper">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("dropdown.storage")}</DialogHeader>
                    <DialogBody>
                        <div className="storage-dialog">
                            <div className="storage-options">
                                <div className="storage-top">
                                    <div className={"storage-tab" + (1 === currentTab ? " storage-item-active" : "")} onClick={() => setCurrentTab(1)}>
                                        <FontAwesomeIcon icon={faGauge}/>
                                        <p>{t("storage.speedtests")}</p>
                                    </div>
                                    <div className={"storage-tab" + (2 === currentTab ? " storage-item-active" : "")} onClick={() => setCurrentTab(2)}>
                                        <FontAwesomeIcon icon={faScrewdriverWrench}/>
                                        <p>{t("storage.configuration")}</p>
                                    </div>
                                </div>
                                <div className="storage-bottom">
                                    <div className="storage-tab reset-cursor">
                                        <FontAwesomeIcon icon={faDatabase}/>
                                        <p>{Math.round(storageSize.size / 1024)} KB</p>
                                    </div>
                                </div>
                            </div>
                            <div className="storage-manager">
                                {currentTab === 1 && <Speedtests tests={storageSize.testCount} close={close}/>}
                                {currentTab === 2 && <Configuration close={close}/>}
                            </div>
                        </div>
                    </DialogBody>
                </>
            )}
        </Dialog>
    );
}
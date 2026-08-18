import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t, changeLanguage} from "i18next";
import {faGlobe} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import {languages} from "@/i18n";
import {useContext, useState} from "react";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {readStored} from "@/common/utils/Storage";

export const LanguageDialog = ({open, onClose}) => {
    const updateToast = useContext(ToastNotificationContext);
    const [selectedLanguage, setSelectedLanguage] = useState(readStored("language") || "en");

    const updateLanguage = (close) => {
        changeLanguage(selectedLanguage);
        updateToast(t('dropdown.language_changed'), "green", faGlobe);
        close();
    };

    return (
        <Dialog open={open} onClose={onClose} className="language-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("update.language")}</DialogHeader>
                    <DialogBody>
                        <div className="language-content">
                            <SelectableList className="language-list">
                                {languages.map((language) => (
                                    <SelectableOption
                                        key={language.code}
                                        image={{src: language.flag, alt: language.name}}
                                        title={language.name}
                                        active={selectedLanguage === language.code}
                                        onClick={() => setSelectedLanguage(language.code)}
                                    />
                                ))}
                            </SelectableList>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" onClick={() => updateLanguage(close)}>{t("dialog.update")}</button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
}

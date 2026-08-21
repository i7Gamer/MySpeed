import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t, changeLanguage} from "i18next";
import {faGlobe} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import {languages} from "@/i18n";
import {useContext, useState} from "react";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {readStored} from "@/common/utils/Storage";
import {supportedLanguage} from "@/common/utils/LanguageChoice";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";

export const LanguageDialog = ({open, onClose}) => {
    const updateToast = useContext(ToastNotificationContext);
    const [selectedLanguage, setSelectedLanguage] = useState(() =>
        supportedLanguage(readStored("language"), languages));

    /**
     * Read when the dialog opens, not at mount - see useSyncOnOpen, and the four
     * sibling dialogs that already do this. The header mounts this long before
     * anything opens it, so a useState initialiser is a single read taken at
     * page load: a language changed in another tab, or chosen and then reopened,
     * left the list highlighting the one this saw first.
     *
     * Through supportedLanguage, because the stored code is not necessarily one
     * of these entries. i18n.js seeds it from `navigator.language`, and a value
     * written by an earlier version was seeded from it unchecked - so a browser
     * set to a language MySpeed does not ship opened this dialog with nothing
     * selected, and no sign of which language was actually in use.
     */
    useSyncOnOpen(open, () => setSelectedLanguage(supportedLanguage(readStored("language"), languages)));

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

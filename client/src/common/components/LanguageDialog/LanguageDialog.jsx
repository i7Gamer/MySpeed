import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import i18n, {changeLanguage} from "i18next";
import {useTranslation} from "react-i18next";
import {faExclamationTriangle, faGlobe} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import {languages} from "@/i18n";
import {useContext, useState} from "react";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {readStored, writeStored} from "@/common/utils/Storage";
import {supportedLanguage} from "@/common/utils/LanguageChoice";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";

export const LanguageDialog = ({open, onClose}) => {
    const {t} = useTranslation();
    const updateToast = useContext(ToastNotificationContext);
    const [saving, setSaving] = useState(false);
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

    /**
     * Written here, not left to the language detector.
     *
     * changeLanguage() reaches storage only because
     * i18next-browser-languagedetector caches it there, and that cache is a no-op
     * when the browser refuses the store - the cross-origin iframe Storage.js
     * exists to keep working, where it falls back to an in-memory Map instead.
     * The seeded value stayed in that Map, so the re-read on open above handed
     * the dialog back a selection the operator had already changed: reopening
     * highlighted English over a German interface, and pressing Update again put
     * the interface back to English.
     *
     * Load before activation: changeLanguage resolves even when its backend
     * failed and can activate a locale with only fallback strings. Checking the
     * backend callback first preserves the current language on a failed fetch.
     * Check the bundle as well: the backend may cache a failed request and
     * finish a later load without an error or any translations. Cached locales
     * need no request at all.
     */
    const updateLanguage = async (close) => {
        if (saving) return;
        setSaving(true);
        try {
            if (!i18n.hasResourceBundle(selectedLanguage, "translation")) {
                await new Promise((resolve, reject) => {
                    i18n.reloadResources([selectedLanguage], ["translation"], error => error ? reject(error) : resolve());
                });
                if (!i18n.hasResourceBundle(selectedLanguage, "translation")) throw new Error("Locale unavailable");
            }
            await changeLanguage(selectedLanguage);
            writeStored("language", selectedLanguage);
            updateToast(i18n.t('dropdown.language_changed'), "green", faGlobe);
            close();
        } catch {
            updateToast(t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} className="language-dialog" disableClose={saving}>
            {({close, forceClose}) => (
                <>
                    <DialogHeader onClose={close} disableClose={saving}>{t("update.language")}</DialogHeader>
                    <DialogBody>
                        <div className="language-content">
                            <SelectableList className="language-list">
                                {languages.map((language) => (
                                    <SelectableOption
                                        key={language.code}
                                        image={{src: language.flag, alt: language.name}}
                                        title={language.name}
                                        active={selectedLanguage === language.code}
                                        onClick={() => { if (!saving) setSelectedLanguage(language.code); }}
                                    />
                                ))}
                            </SelectableList>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" disabled={saving} onClick={() => updateLanguage(forceClose)}>
                            {t(saving ? "dialog.saving" : "dialog.update")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
}

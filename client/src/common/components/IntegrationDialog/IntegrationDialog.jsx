import {Dialog, DialogHeader, DialogBody} from "@/common/contexts/Dialog";
import "./styles.sass";
import React, {useContext, useEffect, useLayoutEffect, useRef, useState} from "react";
import {t} from "i18next";
import i18n from "i18next";
import {faCheck, faCircleNodes, faExclamationTriangle, faFloppyDisk, faTrash, faTrashArrowUp} from "@fortawesome/free-solid-svg-icons";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {deleteRequest, jsonRequest, patchRequest, putRequest} from "@/common/utils/RequestUtil";
import {v4 as uuid} from 'uuid';
import {ConfigContext} from "@/common/contexts/Config";
import {generateRelativeTime} from "@/common/utils/FormatUtil";
import FormField from "@/common/components/FormField";
import ExpandableCard from "@/common/components/ExpandableCard";
import DropdownSelect from "@/common/components/DropdownSelect";
import {renderableIntegrations} from "@/common/components/IntegrationDialog/renderableIntegrations";
import {integrationPayload, isValidDisplayName, isValidFieldValue} from "@/common/components/IntegrationDialog/integrationPayload";
import {appendVariable, variableToken} from "@/common/components/IntegrationDialog/templateVariables";
import {integrationPlaceholder, integrationTitle} from "@/common/utils/InvariantText";

const IntegrationCard = ({integration, integrationDef, onRemove, onUpdate, config}) => {
    const [displayName, setDisplayName] = useState(integration.displayName || integrationTitle(integration.name, t));
    const [fields, setFields] = useState(() => {
        const initial = {};
        integrationDef.fields.forEach(field => {
            const stored = integration.data?.[field.name];
            if (stored !== undefined && stored !== null) {
                initial[field.name] = stored;
            } else if (field.type === "boolean") {
                initial[field.name] = false;
            } else if (field.type === "number") {
                initial[field.name] = "";
            } else {
                initial[field.name] = "";
            }
        });
        return initial;
    });
    const [unsavedChanges, setUnsavedChanges] = useState(false);
    const [saveConfirmed, setSaveConfirmed] = useState(false);
    const [deleteConfirmed, setDeleteConfirmed] = useState(false);
    const [error, setError] = useState(false);
    const [lastActivity, setLastActivity] = useState(generateRelativeTime(integration.lastActivity));

    useEffect(() => {
        const interval = setInterval(() => {
            if (integration.lastActivity) setLastActivity(generateRelativeTime(integration.lastActivity));
        }, 1000);
        return () => clearInterval(interval);
    }, [integration.lastActivity]);

    const updateField = (name, value) => {
        setFields(prev => ({...prev, [name]: value}));
        setUnsavedChanges(true);
    };

    const isValidInput = (field) => isValidFieldValue(field, fields[field.name]);

    /**
     * The label for a field, falling back to the shared namespace.
     *
     * Most fields are an integration's own and are named under it. The
     * threshold settings are declared once and handed to every notifier, so
     * naming them per integration would mean the same six sentences written out
     * six times in each locale - and the lookup here is built from a template
     * literal, which the i18n key scanner cannot see, so every one of those
     * copies would be a string that ships as a raw key the moment it is
     * forgotten.
     */
    const fieldKeys = (fieldName, suffix = "") => [
        `integrations.${integration.name}.fields.${fieldName}${suffix}`,
        `integrations.fields.${fieldName}${suffix}`
    ];

    const getLabel = (fieldName) => {
        const key = fieldKeys(fieldName).find((candidate) => i18n.exists(candidate));
        return key ? t(key) : fieldName;
    };

    /**
     * The invariant placeholders first - the URLs and the numbers, which read
     * the same in every language and are therefore not in the locales at all.
     * See InvariantText.js for why they were taken out of them.
     */
    const getPlaceholder = (fieldName) => {
        const invariant = integrationPlaceholder(integration.name, fieldName);
        if (invariant !== undefined) return invariant;

        const key = fieldKeys(fieldName, "_placeholder").find((candidate) => i18n.exists(candidate));
        return key ? t(key) : getLabel(fieldName);
    };

    const handleSave = async () => {
        const data = integrationPayload(integrationDef, fields, displayName);
        try {
            if (!integration.id) {
                const response = await putRequest(`/integrations/${integration.name}`, data);
                if (!response.ok) throw new Error();
                const result = await response.json();
                onUpdate(integration.uuid, {id: result.id, isNew: false});
            } else {
                const response = await patchRequest(`/integrations/${integration.id}`, data);
                if (!response.ok) throw new Error();
            }
            setUnsavedChanges(false);
            setSaveConfirmed(true);
            setError(false);
            setTimeout(() => setSaveConfirmed(false), 1500);
        } catch {
            setError(true);
        }
    };

    const handleDelete = async () => {
        if (!deleteConfirmed) {
            setDeleteConfirmed(true);
            setTimeout(() => setDeleteConfirmed(false), 3000);
            return;
        }
        if (!integration.id) {
            onRemove(integration.uuid);
            return;
        }
        // Checked before the card disappears: a refused delete used to vanish
        // from the dialog and be back on the next open, with nothing said.
        const response = await deleteRequest(`/integrations/${integration.id}`).catch(() => null);
        if (!response?.ok) {
            setError(true);
            return;
        }
        onRemove(integration.uuid);
    };

    const getStatusClass = () => {
        if (integration.activityFailed) return "status-error";
        if (!integration.lastActivity) return "status-inactive";
        return "status-active";
    };

    const getStatusText = () => {
        if (integration.activityFailed) return t("failed");
        if (!integration.lastActivity) return t("integrations.activity.never_executed");
        return t("integrations.activity.last_run") + lastActivity;
    };

    return (
        <ExpandableCard icon={integrationDef.icon} title={displayName} subtitle={getStatusText()} statusDot={getStatusClass()}
            actions={<>
                {!config.previewMode && unsavedChanges && !saveConfirmed && (
                    <button type="button" className="card-action-btn save-btn" onClick={(e) => {e.stopPropagation(); handleSave();}}>
                        <FontAwesomeIcon icon={faFloppyDisk}/>
                    </button>
                )}
                {saveConfirmed && <span className="card-action-btn success-indicator"><FontAwesomeIcon icon={faCheck}/></span>}
                {!config.previewMode && (
                    <button type="button" className={`card-action-btn delete-btn ${deleteConfirmed ? "confirm" : ""}`}
                            onClick={(e) => {e.stopPropagation(); handleDelete();}}>
                        <FontAwesomeIcon icon={deleteConfirmed ? faTrashArrowUp : faTrash}/>
                    </button>
                )}
            </>}
            defaultExpanded={integration.isNew || false} error={error} success={saveConfirmed}>
            {/* Marked like every declared field. Without this the one value on
                the form that no module declares was also the one nothing could
                point at: the card resends it on every save, so an over-long
                name stored before the server capped it failed each one with a
                generic error over a field the operator never touched. */}
            <FormField label={t("integrations.display_name")} type="text" value={displayName}
                error={!isValidDisplayName(displayName)}
                onChange={(v) => { setDisplayName(v); setUnsavedChanges(true); }} placeholder={t("integrations.display_name")}/>
            {integrationDef.fields.map((field) => (
                <div key={field.name} className="integration-field">
                    <FormField label={getLabel(field.name)}
                        type={field.type} value={fields[field.name]} onChange={(value) => updateField(field.name, value)}
                        placeholder={getPlaceholder(field.name)} error={!isValidInput(field)}
                        min={field.min} max={field.max} decimals={field.decimals}/>
                    {/* Only a template carries a list, and the list is the
                        server's - it is the side that substitutes them. */}
                    {field.variables?.length > 0 && (
                        <div className="template-variables">
                            <span className="template-variables-label">{t("integrations.variables")}</span>
                            <div className="template-variables-list">
                                {field.variables.map((name) => (
                                    <button key={name} type="button" className="template-variable"
                                            title={t("integrations.variables_hint")}
                                            onClick={() => updateField(field.name,
                                                appendVariable(fields[field.name], name))}>
                                        {variableToken(name)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </ExpandableCard>
    );
};

export const IntegrationDialog = ({open, onClose}) => {
    const [config] = useContext(ConfigContext);
    const [integrations, setIntegrations] = useState(null);
    const [active, setActive] = useState(null);

    useEffect(() => {
        if (!open) return;
        Promise.all([jsonRequest("/integrations"), jsonRequest("/integrations/active")]).then(([intData, activeData]) => {
            setIntegrations(intData);
            setActive(activeData.map(item => ({...item, uuid: uuid()})));
        }).catch((error) => console.error("Failed to load the integrations:", error));
    }, [open]);

    // The rows this dialog can actually draw. A stored row whose integration
    // has since been removed has no definition, and IntegrationCard reads
    // `integrationDef.fields` in a state initialiser - so one of those did not
    // render a broken card, it threw during render and took the whole dialog
    // with it. Counted from here too, so a list of nothing but stale rows shows
    // the empty state rather than an empty list.
    const renderable = renderableIntegrations(active, integrations);

    // The wrapper the create menu is drawn in, whichever of the two branches
    // below drew it, and whether the create menu is owed its focus back.
    const wrapperRef = useRef(null);
    const owedFocus = useRef(false);

    const addIntegration = (item) => {
        // Only the first, which is the add that replaces the menu it was made
        // in - see the effect below.
        owedFocus.current = renderable.length === 0;
        setActive([...active, {uuid: uuid(), name: item.key, data: {}, isNew: true}]);
    };

    const removeIntegration = (id) => setActive(active.filter(item => item.uuid !== id));
    const updateIntegration = (id, updates) => setActive(active.map(item => item.uuid === id ? {...item, ...updates} : item));

    /*
     * Focus back on the create menu, when the choice replaced the one it was
     * made in.
     *
     * DropdownSelect hands focus to its own trigger when an item is chosen,
     * which is enough every time but the first. Adding the first integration
     * takes this dialog out of its empty state, and the two branches below hold
     * two different DropdownSelects - so the button just focused is removed in
     * the same commit that draws its replacement.
     *
     * Nothing else catches that. Chrome fires no event at all when a focused
     * element is removed: focus becomes <body> in silence, so the modal trap's
     * recovery, which is a focusout listener, never hears it. The one person
     * this menu exists for - somebody adding their first integration without a
     * mouse - was left behind the backdrop with the next Tab at the top of the
     * document.
     *
     * The same control in its new place, so the first add ends where every
     * later one does.
     *
     * A layout effect, so it runs before the microtask the trap's own watcher
     * is delivered on: the watcher would otherwise see focus on the body first
     * and seat it on the new card, and a reader would hear that control named
     * before this one. Both end here; only one of them is announced.
     */
    useLayoutEffect(() => {
        if (!owedFocus.current) return;

        owedFocus.current = false;
        wrapperRef.current?.querySelector(".dropdown-select-btn")?.focus();
    }, [renderable.length]);

    const dropdownItems = integrations ? Object.entries(integrations).map(([name, def]) => ({
        key: name, label: integrationTitle(name, t), icon: def.icon
    })) : [];

    const loading = !integrations || !active;

    return (
        <Dialog open={open} onClose={onClose} className="integration-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("dropdown.integrations")}</DialogHeader>
                    <DialogBody>
                        {loading ? (
                            <div className="lds-ellipsis"><div/><div/><div/><div/></div>
                        ) : (
                            <div className="integrations-wrapper" ref={wrapperRef}>
                                {config.previewMode && renderable.length > 0 && (
                                    <div className="preview-warning">
                                        <FontAwesomeIcon icon={faExclamationTriangle}/>
                                        <span>{t("integrations.preview_active")}</span>
                                    </div>
                                )}
                                {renderable.length === 0 ? (
                                    <div className="empty-state">
                                        <FontAwesomeIcon icon={faCircleNodes}/>
                                        <p>{t("integrations.none_active").replace("<br/>", " ").replace("<Bold>", "").replace("</Bold>", "")}</p>
                                        <DropdownSelect items={dropdownItems} onSelect={addIntegration} buttonText={t("integrations.create")} disabled={config.previewMode}/>
                                    </div>
                                ) : (
                                    <>
                                        <div className="integrations-list">
                                            {renderable.map(item => (
                                                <IntegrationCard key={item.uuid} integration={item} integrationDef={integrations[item.name]}
                                                    onRemove={removeIntegration} onUpdate={updateIntegration} config={config}/>
                                            ))}
                                        </div>
                                        <DropdownSelect items={dropdownItems} onSelect={addIntegration} buttonText={t("integrations.create")} disabled={config.previewMode}/>
                                    </>
                                )}
                            </div>
                        )}
                    </DialogBody>
                </>
            )}
        </Dialog>
    );
};
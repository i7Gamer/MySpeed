import {Dialog, DialogHeader, DialogBody} from "@/common/contexts/Dialog";
import "./styles.sass";
import React, {useContext, useEffect, useState} from "react";
import {t} from "i18next";
import i18n from "i18next";
import {faCheck, faCircleNodes, faExclamationTriangle, faFloppyDisk, faTrash, faTrashArrowUp} from "@fortawesome/free-solid-svg-icons";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {deleteRequest, jsonRequest, patchRequest, putRequest} from "@/common/utils/RequestUtil";
import {v4 as uuid} from 'uuid';
import {ConfigContext} from "@/common/contexts/Config";
import {generateRelativeTime} from "@/pages/Home/components/LatestTest/utils";
import FormField from "@/common/components/FormField";
import ExpandableCard from "@/common/components/ExpandableCard";
import DropdownSelect from "@/common/components/DropdownSelect";

const IntegrationCard = ({integration, integrationDef, onRemove, onUpdate, config}) => {
    const [displayName, setDisplayName] = useState(integration.displayName || t(`integrations.${integration.name}.title`));
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

    const isValidInput = (field) => {
        const value = fields[field.name];
        const isEmpty = value === undefined || value === null || value === "";
        if (field.required && isEmpty) return false;
        if (!isEmpty) {
            if (field.regex && !new RegExp(field.regex).test(value)) return false;
            if (field.type === "text" && value.length > 255) return false;
            if (field.type === "textarea" && value.length > 2000) return false;
            if (field.type === "number") {
                if (!Number.isInteger(Number(value))) return false;
                if (field.min !== undefined && Number(value) < field.min) return false;
                if (field.max !== undefined && Number(value) > field.max) return false;
            }
        }
        return true;
    };

    const getPlaceholder = (fieldName) => {
        const placeholderKey = `integrations.${integration.name}.fields.${fieldName}_placeholder`;
        const baseKey = `integrations.${integration.name}.fields.${fieldName}`;
        return i18n.exists(placeholderKey) ? t(placeholderKey) : t(baseKey);
    };

    const handleSave = async () => {
        const cleanedFields = {};
        integrationDef.fields.forEach(field => {
            const v = fields[field.name];
            if (field.type === "number" && (v === "" || v === null || v === undefined)) return;
            cleanedFields[field.name] = v;
        });
        const data = {...cleanedFields, integration_name: displayName};
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
        await deleteRequest(`/integrations/${integration.id}`);
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
                    <button className="card-action-btn save-btn" onClick={(e) => {e.stopPropagation(); handleSave();}}>
                        <FontAwesomeIcon icon={faFloppyDisk}/>
                    </button>
                )}
                {saveConfirmed && <span className="card-action-btn success-indicator"><FontAwesomeIcon icon={faCheck}/></span>}
                {!config.previewMode && (
                    <button className={`card-action-btn delete-btn ${deleteConfirmed ? "confirm" : ""}`}
                            onClick={(e) => {e.stopPropagation(); handleDelete();}}>
                        <FontAwesomeIcon icon={deleteConfirmed ? faTrashArrowUp : faTrash}/>
                    </button>
                )}
            </>}
            defaultExpanded={integration.isNew || false} error={error} success={saveConfirmed}>
            <FormField label={t("integrations.display_name")} type="text" value={displayName}
                onChange={(v) => { setDisplayName(v); setUnsavedChanges(true); }} placeholder={t("integrations.display_name")}/>
            {integrationDef.fields.map((field) => (
                <FormField key={field.name} label={t(`integrations.${integration.name}.fields.${field.name}`)}
                    type={field.type} value={fields[field.name]} onChange={(value) => updateField(field.name, value)}
                    placeholder={getPlaceholder(field.name)} error={!isValidInput(field)}
                    min={field.min} max={field.max}/>
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

    const addIntegration = (item) => setActive([...active, {uuid: uuid(), name: item.key, data: {}, isNew: true}]);
    const removeIntegration = (id) => setActive(active.filter(item => item.uuid !== id));
    const updateIntegration = (id, updates) => setActive(active.map(item => item.uuid === id ? {...item, ...updates} : item));

    const dropdownItems = integrations ? Object.entries(integrations).map(([name, def]) => ({
        key: name, label: t(`integrations.${name}.title`), icon: def.icon
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
                            <div className="integrations-wrapper">
                                {config.previewMode && active.length > 0 && (
                                    <div className="preview-warning">
                                        <FontAwesomeIcon icon={faExclamationTriangle}/>
                                        <span>{t("integrations.preview_active")}</span>
                                    </div>
                                )}
                                {active.length === 0 ? (
                                    <div className="empty-state">
                                        <FontAwesomeIcon icon={faCircleNodes}/>
                                        <p>{t("integrations.none_active").replace("<br/>", " ").replace("<Bold>", "").replace("</Bold>", "")}</p>
                                        <DropdownSelect items={dropdownItems} onSelect={addIntegration} buttonText={t("integrations.create")} disabled={config.previewMode}/>
                                    </div>
                                ) : (
                                    <>
                                        <div className="integrations-list">
                                            {active.map(item => (
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
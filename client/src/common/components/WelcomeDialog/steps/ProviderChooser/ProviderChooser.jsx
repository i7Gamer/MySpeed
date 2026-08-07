import "./styles.sass";

import {providers} from "@/common/components/ProviderDialog/ProviderDialog";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {t} from "i18next";

export const ProviderChooser = ({provider, setProvider}) => {
    return (
        <div className="provider-chooser">
            <h2>{t("welcome.provider_title")}</h2>
            <p>{t("welcome.provider_subtext")}</p>
            <SelectableList className="provider-list">
                {providers.map((current) => (
                    <SelectableOption key={current.id}
                                      image={{src: current.image, alt: current.name}}
                                      title={current.name}
                                      description={t(`dialog.provider.${current.id}_desc`)}
                                      active={current.id === provider}
                                      onClick={() => setProvider(current.id)}/>
                ))}
            </SelectableList>
        </div>
    );
}

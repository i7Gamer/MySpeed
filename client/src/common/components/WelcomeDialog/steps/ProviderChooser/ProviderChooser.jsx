import "./styles.sass";

import {providers, requiresEndpoint} from "@/common/components/TargetsDialog/providers";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faServer} from "@fortawesome/free-solid-svg-icons";
import {IPERF_HOST_PLACEHOLDER} from "@/common/utils/InvariantText";
import {t} from "i18next";

export const ProviderChooser = ({provider, setProvider, endpoint, setEndpoint}) => {
    return (
        <div className="provider-chooser">
            <h2>{t("welcome.provider_title")}</h2>
            <p>{t("welcome.provider_subtext")}</p>
            <SelectableList className="provider-list">
                {providers.map((current) => (
                    <SelectableOption key={current.id}
                                      icon={current.icon}
                                      // Only the providers that have a logo. A
                                      // card given `{src: undefined}` draws a
                                      // broken image, which is what iperf3 -
                                      // the one carrying a glyph instead -
                                      // rendered here.
                                      image={current.image
                                          ? {src: current.image, alt: current.name} : undefined}
                                      title={current.name}
                                      description={t(`dialog.provider.${current.id}_desc`)}
                                      active={current.id === provider}
                                      onClick={() => setProvider(current.id)}/>
                ))}
            </SelectableList>

            {/* The address a provider cannot do without, asked for here rather
                than left to fail on the last step: this dialog cannot be
                closed and has no way back to this one. Named and shaped the
                way the target editor names and shapes it, so the two screens
                ask the same question in the same words. */}
            {requiresEndpoint(provider) && (
                <div className="provider-endpoint">
                    <div className="provider-endpoint-label">
                        <FontAwesomeIcon icon={faServer}/>
                        <h3>{t("dialog.provider.iperf_host")}</h3>
                    </div>
                    <input type="text" className="dialog-input"
                           placeholder={IPERF_HOST_PLACEHOLDER}
                           value={endpoint} onChange={(e) => setEndpoint(e.target.value)}/>
                </div>
            )}
        </div>
    );
}

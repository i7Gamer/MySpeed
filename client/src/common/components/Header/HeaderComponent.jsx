import "./styles.sass";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faCircleArrowUp, faDownload,
    faGear,
    faLock,
    faClose,
    faServer
} from "@fortawesome/free-solid-svg-icons";
import { useContext, useEffect, useState } from "react";
import DropdownComponent from "../Dropdown/DropdownComponent";
import { useAlert } from "@/common/contexts/Alert";
import { jsonRequest, login } from "@/common/utils/RequestUtil";
import { promptUntilAccepted } from "@/common/utils/PasswordPrompt";
import { refusalDescriptionKey } from "@/common/utils/AuthOutcome";
import { updateInfo } from "@/common/components/Header/utils/infos";
import { t } from "i18next";
import { ConfigContext } from "@/common/contexts/Config";
import { NodeContext } from "@/common/contexts/Node";
import { INSTALL_URL, RELEASES_URL } from "@/index";
import { Trans } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import Pagination from "./components/Pagination";
import AboutDialog from "@/common/components/AboutDialog";
import Tooltip from "@/common/components/Tooltip";

const HeaderComponent = () => {
    const findNode = useContext(NodeContext)[4];
    const currentNode = useContext(NodeContext)[2];
    const navigate = useNavigate();
    const location = useLocation();

    const alert = useAlert();
    const [icon, setIcon] = useState(faGear);
    const [config, reloadConfig, checkConfig] = useContext(ConfigContext);
    const [updateAvailable, setUpdateAvailable] = useState("");
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [showAboutDialog, setShowAboutDialog] = useState(false);

    const switchDropdown = () => {
        setIsDropdownOpen(!isDropdownOpen);
        setIcon(isDropdownOpen ? faGear : faClose);
    }

    const showDemoDialog = () => alert.openAlert(
        t("preview.title"),
        <Trans components={{ Link: <a href={INSTALL_URL} target="_blank" /> }}>preview.description</Trans>,
        { buttonText: t("dialog.okay") }
    );

    // The same loop the unauthenticated page uses, so the two prompts cannot
    // disagree about what a rejected password means. Read-level access counts
    // as a rejection here: it authenticates, but not for the admin controls
    // this dialog was opened to reach.
    const showPasswordDialog = () => promptUntilAccepted(
        (previous) => alert.openInput(t("header.admin_login"), {
            placeholder: t("dialog.password.placeholder"),
            // What the refusal was, not simply that there was one: a lockout
            // asks for a minute, not another attempt - see refusalDescriptionKey.
            description: previous ? <span className="icon-red">{t(refusalDescriptionKey(previous.type))}</span> : "",
            inputType: "password",
            buttonText: t("dialog.login")
        }),
        // Exchanged for a session cookie rather than kept: the password itself
        // never reaches storage this script can read back.
        async (value) => {
            const outcome = await login(value);
            if (!outcome.ok) return outcome;

            reloadConfig();
            const newConfig = await checkConfig().catch(() => null);

            // Read-level access authenticates, but not for the admin controls
            // this dialog was opened to reach, so it counts as a refusal.
            return {ok: !newConfig?.viewMode};
        }
    );

    const openDownloadPage = () => window.open(RELEASES_URL, "_blank");

    useEffect(() => {
        if (Object.keys(config).length === 0) return;
        async function updateVersion() {
            const version = await jsonRequest("/info/version").catch(() => null);
            if (!version?.remote || !version?.local) return;

            if (version.remote.localeCompare(version.local, undefined, { numeric: true, sensitivity: 'base' }) === 1)
                setUpdateAvailable(version.remote);
        }

        if (!config.viewMode) updateVersion();
    }, [config]);

    const getNodeName = () => currentNode === "0" ? t("header.title") : findNode(currentNode)?.name || t("header.title");

    if (location.pathname === "/nodes") return <></>;
    if (Object.keys(config).length === 0) return <></>;

    return (
        <header>
            <AboutDialog open={showAboutDialog} onClose={() => setShowAboutDialog(false)}/>
            <div className="header-main">
                <div className="header-left">
                    {/* One title for everyone, read-only visitors included:
                        the About dialog behind it holds nothing but public
                        links, so there was no reason for view mode to get a
                        bare, inert heading. In view mode the node list is
                        never loaded and getNodeName falls back to the plain
                        title on its own.

                        The span is what lets the title shrink: a bare text
                        node in a flex h2 is an anonymous item that cannot be
                        styled, so it could never trade width for an ellipsis
                        and pushed into the pagination instead. */}
                    <h2 className="header-about" onClick={() => setShowAboutDialog(true)}><img src="/assets/img/logo192.png" alt="MySpeed Logo" className="header-logo" /> <span className="header-title">{getNodeName()}</span></h2>

                    {config.previewMode && <h2 className="demo-info" onClick={showDemoDialog}>{t("preview.info")}</h2>}
                </div>

                <Pagination />

                {/* No timeframe selector and no start control up here any
                    more: the overview and the statistics both carry the page
                    toolbar, which owns the range and the start button, and a
                    second control for either only raises the question of
                    which one the page obeys. */}
                <div className="header-right">
                    {updateAvailable ?
                        <div><FontAwesomeIcon icon={faCircleArrowUp} className="header-icon icon-orange update-icon"
                                              onClick={() => alert.openAlert(
                                                  t("header.new_update"),
                                                  updateInfo(updateAvailable),
                                                  { buttonText: t("dialog.okay") }
                                              )} /></div> : <></>}

                    {config.viewMode ?
                        <Tooltip content={t("header.admin_login")} position="bottom">
                            {/* Wrapped, not passed bare: React calls a handler
                                with the event, which arrives as `failed` and is
                                truthy, so the dialog opened already saying the
                                password was wrong. */}
                            <FontAwesomeIcon icon={faLock} className={"header-icon"}
                                             onClick={() => showPasswordDialog()} />
                        </Tooltip>
                    : <></>}

                    {config.previewMode ? 
                        <Tooltip content={t("header.download")} position="bottom">
                            <FontAwesomeIcon icon={faDownload} className={"header-icon"} onClick={openDownloadPage} />
                        </Tooltip>
                    : <></>}

                    {!config.viewMode && 
                        <Tooltip content={t("header.servers")} position="bottom">
                            <FontAwesomeIcon icon={faServer} className="header-icon" onClick={() => navigate("/nodes")} />
                        </Tooltip>
                    }

                    <Tooltip content={t("dropdown.settings")} position="bottom">
                        <div id="open-header">
                            <FontAwesomeIcon icon={icon} className="header-icon" onClick={switchDropdown} />
                        </div>
                    </Tooltip>
                </div>
            </div>
            <DropdownComponent isOpen={isDropdownOpen} switchDropdown={switchDropdown} />
        </header>
    )
}

export default HeaderComponent;
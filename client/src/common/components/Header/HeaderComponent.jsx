import "./styles.sass";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faCircleArrowUp, faDownload,
    faGaugeHigh,
    faGear,
    faLock,
    faClose,
    faServer
} from "@fortawesome/free-solid-svg-icons";
import { useContext, useEffect, useState } from "react";
import DropdownComponent from "../Dropdown/DropdownComponent";
import { useAlert } from "@/common/contexts/Alert";
import { StatusContext } from "@/common/contexts/Status";
import { SpeedtestContext } from "@/common/contexts/Speedtests";
import { jsonRequest, login } from "@/common/utils/RequestUtil";
import { startSpeedtest as runSpeedtest } from "@/common/utils/RunUtil";
import { showsStatusBar } from "@/common/utils/StatusUtil";
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
import TimeframeSelector from "@/common/components/TimeframeSelector";

const HeaderComponent = () => {
    const findNode = useContext(NodeContext)[4];
    const currentNode = useContext(NodeContext)[2];
    const navigate = useNavigate();
    const location = useLocation();

    const alert = useAlert();
    const [icon, setIcon] = useState(faGear);
    const [status, updateStatus, setRunning] = useContext(StatusContext);
    const {updateTests} = useContext(SpeedtestContext);
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

    const showPasswordDialog = async (failed = false) => {
        const result = await alert.openInput(t("header.admin_login"), {
            placeholder: t("dialog.password.placeholder"),
            description: failed ? <span className="icon-red">{t("dialog.password.wrong")}</span> : "",
            inputType: "password",
            buttonText: t("dialog.login")
        });

        if (!result) return;

        // Exchanged for a session cookie rather than kept: the password itself
        // never reaches storage this script can read back.
        if (!await login(result)) return showPasswordDialog(true);

        reloadConfig();
        const newConfig = await checkConfig().catch(() => null);
        if (newConfig?.viewMode) showPasswordDialog(true);
    };

    // Shared with the status bar on the overview: two controls for the same
    // action decided separately when it was allowed, which is how they end up
    // disagreeing.
    const startSpeedtest = () =>
        runSpeedtest({status, config, updateStatus, setRunning, updateTests, alert});

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
                    {config.viewMode && <h2>{t("header.title")}</h2>}
                    {!config.viewMode && <h2 className="header-about" onClick={() => setShowAboutDialog(true)}><img src="/assets/img/logo192.png" alt="MySpeed Logo" className="header-logo" /> {getNodeName()}</h2>}

                    {config.previewMode && <h2 className="demo-info" onClick={showDemoDialog}>{t("preview.info")}</h2>}
                </div>

                <Pagination />

                <div className="header-right">
                    <TimeframeSelector />

                    {updateAvailable ?
                        <div><FontAwesomeIcon icon={faCircleArrowUp} className="header-icon icon-orange update-icon"
                                              onClick={() => alert.openAlert(
                                                  t("header.new_update"),
                                                  updateInfo(updateAvailable),
                                                  { buttonText: t("dialog.okay") }
                                              )} /></div> : <></>}

                    {/* Hidden on the overview, where the status bar carries the
                        same control with a label on it. Two buttons for one
                        action on one screen only raises the question of whether
                        they do the same thing. */}
                    {!(status.paused || config.viewMode || showsStatusBar(location.pathname)) ?
                        <Tooltip content={t("header." + (status.running ? "running_tooltip" : "start_tooltip"))} position="bottom">
                            <FontAwesomeIcon icon={faGaugeHigh}
                                             className={"header-icon " + (status.running ? "test-running" : "")}
                                             onClick={startSpeedtest} />
                        </Tooltip>
                    : <></>}

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
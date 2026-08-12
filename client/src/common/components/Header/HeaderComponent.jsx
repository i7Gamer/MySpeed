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
import { nodeTitle } from "@/common/components/Header/nodeTitle";
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

    const getNodeName = () => nodeTitle(currentNode, findNode, t("header.title"));

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
                    {/* The button sits inside the heading rather than replacing
                        it: the instance name is the page's heading and stays
                        one, while the thing that opens the dialog is something
                        a keyboard can reach. It used to be the h2's own
                        onClick, which announced as a heading and tabbed to
                        nothing. */}
                    <h2 className="header-about-heading">
                        <button type="button" className="header-about"
                                aria-label={t("about.title")}
                                onClick={() => setShowAboutDialog(true)}>
                            <img src="/assets/img/logo192.png" alt="" className="header-logo"/>
                            {" "}<span className="header-title">{getNodeName()}</span>
                        </button>
                    </h2>

                    {config.previewMode &&
                        <button type="button" className="demo-info" onClick={showDemoDialog}>{t("preview.info")}</button>}
                </div>

                <Pagination />

                {/* No timeframe selector and no start control up here any
                    more: the overview and the statistics both carry the page
                    toolbar, which owns the range and the start button, and a
                    second control for either only raises the question of
                    which one the page obeys. */}
                {/* Every one of these is a real <button>. They were
                    FontAwesomeIcons carrying an onClick - <svg role="img">,
                    which is neither focusable nor announced as a control - so
                    the header held no tabbable element at all and a keyboard
                    user could not open the settings, reach the servers page or
                    sign in as an administrator. The tooltip already names each
                    one for a pointer; aria-label is the same sentence for
                    everyone else. */}
                <div className="header-right">
                    {updateAvailable ?
                        <button type="button" className="header-icon icon-orange update-icon"
                                aria-label={t("header.new_update")}
                                onClick={() => alert.openAlert(
                                    t("header.new_update"),
                                    updateInfo(updateAvailable),
                                    { buttonText: t("dialog.okay") }
                                )}>
                            <FontAwesomeIcon icon={faCircleArrowUp}/>
                        </button> : <></>}

                    {config.viewMode ?
                        <Tooltip content={t("header.admin_login")} position="bottom">
                            {/* Wrapped, not passed bare: React calls a handler
                                with the event, which arrives as `failed` and is
                                truthy, so the dialog opened already saying the
                                password was wrong. */}
                            <button type="button" className="header-icon"
                                    aria-label={t("header.admin_login")}
                                    onClick={() => showPasswordDialog()}>
                                <FontAwesomeIcon icon={faLock}/>
                            </button>
                        </Tooltip>
                    : <></>}

                    {config.previewMode ?
                        <Tooltip content={t("header.download")} position="bottom">
                            <button type="button" className="header-icon"
                                    aria-label={t("header.download")} onClick={openDownloadPage}>
                                <FontAwesomeIcon icon={faDownload}/>
                            </button>
                        </Tooltip>
                    : <></>}

                    {!config.viewMode &&
                        <Tooltip content={t("header.servers")} position="bottom">
                            <button type="button" className="header-icon"
                                    aria-label={t("header.servers")} onClick={() => navigate("/nodes")}>
                                <FontAwesomeIcon icon={faServer}/>
                            </button>
                        </Tooltip>
                    }

                    <Tooltip content={t("dropdown.settings")} position="bottom">
                        {/* The id stays on the wrapper: useClickOutside asks
                            closest("#open-header") whether a mousedown was the
                            opener rather than an outside click. */}
                        <div id="open-header">
                            <button type="button" className="header-icon"
                                    aria-label={t("dropdown.settings")}
                                    aria-expanded={isDropdownOpen} onClick={switchDropdown}>
                                <FontAwesomeIcon icon={icon}/>
                            </button>
                        </div>
                    </Tooltip>
                </div>
            </div>
            <DropdownComponent isOpen={isDropdownOpen} switchDropdown={switchDropdown} />
        </header>
    )
}

export default HeaderComponent;
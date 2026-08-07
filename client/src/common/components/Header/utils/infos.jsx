import {Trans} from "react-i18next";
import {RELEASES_URL, INSTALL_URL} from "@/index";

// "the changes" goes to the release notes; "download the update" goes to the
// README, which covers every install method rather than assuming a download -
// updating a docker install is a pull, not a file.
export const updateInfo = (version) => <Trans values={{version}} components={{Changes: <a href={RELEASES_URL} target="_blank"/>,
    DLLink: <a href={INSTALL_URL} target="_blank"/>}}>info.update</Trans>
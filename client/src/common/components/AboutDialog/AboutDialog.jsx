import { Dialog, DialogHeader, DialogBody } from "@/common/contexts/Dialog";
import "./styles.sass";
import React, { useContext, useEffect, useState } from "react";
import { t } from "i18next";
import {
  faDownload,
  faLanguage,
} from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { jsonRequest } from "@/common/utils/RequestUtil";
import { ConfigContext } from "@/common/contexts/Config";
import { PROJECT_URL, RELEASES_URL } from "@/index";
import {withBasePath} from "@/common/utils/BasePath";

export const AboutDialog = ({ open, onClose }) => {
  const [config] = useContext(ConfigContext);
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!open) return;

    // The version endpoint is admin-gated, the same policy as the header's
    // update check - a read-only visitor would be refused anyway, so the
    // dialog does not ask and the badge simply stays off.
    if (config.viewMode) return setVersion(null);

    jsonRequest("/info/version").then((data) => setVersion(data.local)).catch(() => setVersion(null));
  }, [open, config.viewMode]);

  const links = [
    { icon: faGithub, label: t("about.github"), url: PROJECT_URL },
    // Was a "Website" link to a site this fork does not have; a link to the
    // downloads is useful where a second link to the same repository was not.
    { icon: faDownload, label: t("header.download"), url: RELEASES_URL },
    {
      icon: faLanguage,
      label: t("about.translate"),
      url: "https://crowdin.com/project/myspeed",
    },
  ];

  return (
    <Dialog open={open} onClose={onClose} className="about-dialog">
      {({ close }) => (
        <>
          <DialogHeader onClose={close}>
            <span className="about-title">
              <img src={withBasePath("/assets/img/logo192.png")} alt="MySpeed" />
              <span>{t("about.title")}</span>
              {version && <span className="about-version">v{version}</span>}
            </span>
          </DialogHeader>
          <DialogBody>
            <div className="about-content">
              <p className="about-description">{t("about.description")}</p>

              <div className="about-links">
                {links.map((link, index) => (
                  <a
                    key={index}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="about-link"
                  >
                    <FontAwesomeIcon icon={link.icon} />
                    <span>{link.label}</span>
                  </a>
                ))}
              </div>

            </div>
          </DialogBody>
        </>
      )}
    </Dialog>
  );
};

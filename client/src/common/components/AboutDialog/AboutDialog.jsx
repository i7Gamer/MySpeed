import { Dialog, DialogHeader, DialogBody } from "@/common/contexts/Dialog";
import "./styles.sass";
import React, { useEffect, useState } from "react";
import { t } from "i18next";
import {
  faGlobe,
  faHeart,
  faLanguage,
  faDollarSign,
} from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { jsonRequest } from "@/common/utils/RequestUtil";
import { PROJECT_URL, WEB_URL, DONATION_URL } from "@/index";

export const AboutDialog = ({ open, onClose }) => {
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!open) return;
    jsonRequest("/info/version").then((data) => setVersion(data.local)).catch(() => setVersion(null));
  }, [open]);

  const links = [
    { icon: faGithub, label: t("about.github"), url: PROJECT_URL },
    { icon: faGlobe, label: t("about.website"), url: WEB_URL },
    {
      icon: faLanguage,
      label: t("about.translate"),
      url: "https://crowdin.com/project/myspeed",
    },
    { icon: faDollarSign, label: t("about.donate"), url: DONATION_URL },
  ];

  return (
    <Dialog open={open} onClose={onClose} className="about-dialog">
      {({ close }) => (
        <>
          <DialogHeader onClose={close}>
            <span className="about-title">
              <img src="/assets/img/logo192.png" alt="MySpeed" />
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

              <div className="about-footer">
                <span>{t("about.made_by")}</span>
                <FontAwesomeIcon icon={faHeart} />
                <span>by</span>
                <a
                  href="https://github.com/gnmyt"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GNMYT
                </a>
              </div>
            </div>
          </DialogBody>
        </>
      )}
    </Dialog>
  );
};

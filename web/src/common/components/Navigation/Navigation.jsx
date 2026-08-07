import "./styles.sass";
import Logo from "@/common/assets/logo192.png";
import {
  faXmark,
  faBars,
  faArrowUpRightFromSquare,
} from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
import { Link, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState, useEffect } from "react";
import { DOCUMENTATION_BASE } from "@/common/utils/constants";

export const GITHUB_LINK = "https://github.com/i7Gamer/MySpeed";

const NAV_ITEMS = [
  { path: "/", label: "Home", isExternal: false },
  { path: "/install", label: "Install", isExternal: false },
  { path: "/tutorials", label: "Tutorials", isExternal: false },
  { path: DOCUMENTATION_BASE, label: "Docs", isExternal: true },
];

export const Navigation = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  const isActive = (path) => location.pathname === path;

  return (
    <>
      <nav className={scrolled ? "nav-scrolled" : ""}>
        <div className="nav-inner">
          <Link className="logo-area" to="/" aria-label="MySpeed home">
            <img src={Logo} alt="" />
            <span>MySpeed</span>
          </Link>

          <div className="nav-links" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) =>
              item.isExternal ? (
                <a
                  key={item.path}
                  href={item.path}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.label}
                  <FontAwesomeIcon
                    icon={faArrowUpRightFromSquare}
                    className="external-icon"
                  />
                </a>
              ) : (
                <Link
                  key={item.path}
                  to={item.path}
                  className={isActive(item.path) ? "active" : ""}
                >
                  {item.label}
                </Link>
              ),
            )}
          </div>

          <div className="nav-actions">
            <a
              href={GITHUB_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="github-link"
              aria-label="Open MySpeed on GitHub"
            >
              <FontAwesomeIcon icon={faGithub} />
            </a>

            <button
              className="mobile-toggle"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Toggle menu"
            >
              <FontAwesomeIcon icon={mobileOpen ? faXmark : faBars} />
            </button>
          </div>
        </div>
      </nav>

      <div className={`mobile-nav ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="mobile-header">
          <Link to="/" className="mobile-logo">
            <img src={Logo} alt="MySpeed Logo" />
            <span>MySpeed</span>
          </Link>
          <button className="mobile-close" onClick={() => setMobileOpen(false)}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="mobile-links">
          {NAV_ITEMS.map((item) =>
            item.isExternal ? (
              <a
                key={item.path}
                href={item.path}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.label}
                <FontAwesomeIcon
                  icon={faArrowUpRightFromSquare}
                  className="external-icon"
                />
              </a>
            ) : (
              <Link
                key={item.path}
                to={item.path}
                className={isActive(item.path) ? "active" : ""}
              >
                {item.label}
              </Link>
            ),
          )}
          <a href={GITHUB_LINK} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
      </div>

      {mobileOpen && (
        <div className="mobile-overlay" onClick={() => setMobileOpen(false)} />
      )}
    </>
  );
};

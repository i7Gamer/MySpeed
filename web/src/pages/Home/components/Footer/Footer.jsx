import {Link} from "react-router-dom";
import "./styles.sass";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faGithub} from "@fortawesome/free-brands-svg-icons";
import {DOCUMENTATION_BASE} from "@/common/utils/constants";

const GITHUB_LINK = "https://github.com/i7Gamer/MySpeed";

export const Footer = () => {
    return (
        <footer className="footer">
            <div className="footer-content">
                <div className="footer-left">
                    <p>© {new Date().getFullYear()} Mathias Wagner</p>
                </div>
                
                <div className="footer-links">
                    <Link to="/install">Install</Link>
                    <Link to="/tutorials">Tutorials</Link>
                    <a href={DOCUMENTATION_BASE} target="_blank" rel="noopener noreferrer">Docs</a>
                    <Link to="/imprint">Imprint</Link>
                    <Link to="/privacy">Privacy</Link>
                </div>

                <div className="footer-right">
                    <a href={GITHUB_LINK} target="_blank" rel="noopener noreferrer" className="github-link">
                        <FontAwesomeIcon icon={faGithub}/>
                    </a>
                </div>
            </div>
        </footer>
    )
}
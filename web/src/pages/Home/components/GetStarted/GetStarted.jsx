import "./styles.sass";
import Button from "@/common/components/Button/index.js";
import {faArrowRight} from "@fortawesome/free-solid-svg-icons";
import {faGithub} from "@fortawesome/free-brands-svg-icons";
import {useNavigate} from "react-router-dom";

const GITHUB_LINK = "https://github.com/i7Gamer/MySpeed";

export const GetStarted = () => {
    const navigate = useNavigate();
    
    return (
        <section className="cta-section">
            <h2>Ready to get started?</h2>
            <div className="cta-actions">
                <Button 
                    text="Install" 
                    icon={faArrowRight} 
                    color="primary"
                    onClick={() => navigate("/install")} 
                />
                <Button 
                    text="GitHub" 
                    icon={faGithub} 
                    color="primary"
                    variant="outline"
                    onClick={() => window.open(GITHUB_LINK, "_blank")} 
                />
            </div>
        </section>
    );
}
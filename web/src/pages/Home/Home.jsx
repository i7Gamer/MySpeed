import InterfaceImage from "@/common/assets/interface.png";
import "./styles.sass";
import {faArrowRight} from "@fortawesome/free-solid-svg-icons";
import {faGithub} from "@fortawesome/free-brands-svg-icons";
import Features from "@/pages/Home/components/Features";
import FeatureGrid from "@/pages/Home/components/FeatureGrid";
import GetStarted from "@/pages/Home/components/GetStarted";
import Footer from "@/pages/Home/components/Footer";
import Button from "@/common/components/Button";
import {useNavigate} from "react-router-dom";

const GITHUB_LINK = "https://github.com/i7Gamer/MySpeed";

export const Home = () => {
    const navigate = useNavigate();

    return (
        <div className="home-page">
            <section className="hero">
                <div className="hero-grid">
                    <div className="hero-content">
                        <h1 className="hero-title">
                            Know Your <span className="highlight">True<svg className="underline-scribble" viewBox="0 0 120 20" preserveAspectRatio="none"><path d="M3,10 Q30,3 60,10 T117,8" /></svg></span> Speed
                        </h1>
                        <p className="hero-description">
                            Monitor your internet connection 24/7 with automated speed tests.
                            Track download, upload, and ping over time - self-hosted and open source.
                        </p>

                        <div className="hero-actions">
                            <Button
                                text="Get Started"
                                icon={faArrowRight}
                                color="primary"
                                size="lg"
                                onClick={() => navigate("/install")}
                            />
                            <Button
                                text="GitHub"
                                icon={faGithub}
                                color="primary"
                                variant="outline"
                                size="lg"
                                onClick={() => window.open(GITHUB_LINK, "_blank")}
                            />
                        </div>
                    </div>

                    <div className="hero-visual">
                        <div className="interface-preview">
                            <img src={InterfaceImage} alt="MySpeed Interface" draggable={false}/>
                        </div>
                    </div>
                </div>
            </section>

            <Features/>
            <FeatureGrid/>
            <GetStarted/>
            <Footer/>
        </div>
    )
}
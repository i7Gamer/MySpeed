import Banner from "@/common/components/WelcomeDialog/banner.webp";
import "./styles.sass";
import {t} from "i18next";

export const Greetings = () => {
    return (
        <div className="welcome-greetings">
            {/* Decorative: the heading below says what this is, in the reader's
                own language, and the banner adds nothing a reader who
                cannot see it needs. */}
            <img src={Banner} alt=""/>
            <h2>{t("welcome.title")}</h2>
            <p>{t("welcome.subtext")}</p>
        </div>
    );
}
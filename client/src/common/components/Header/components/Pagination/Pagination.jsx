import "./styles.sass";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChartArea, faListUl } from "@fortawesome/free-solid-svg-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useTranslation } from "react-i18next";

export const Pagination = memo(() => {
    // Not the global `t`: memo with no props blocks the re-render every other
    // component gets from the layout root on languageChanged, so this one has
    // to hold its own subscription or its labels outlive the language.
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const [activeIndex, setActiveIndex] = useState(location.pathname === "/" ? 0 : 1);
    const paginationRef = useRef(null);
    const itemRefs = useRef([]);

    useEffect(() => {
        const currentIndex = location.pathname === "/" ? 0 : 1;
        setActiveIndex(currentIndex);
    }, [location.pathname]);

    const updateActiveBackground = useCallback(() => {
        if (paginationRef.current && itemRefs.current[activeIndex]) {
            const { offsetLeft, offsetWidth } = itemRefs.current[activeIndex];
            paginationRef.current.style.setProperty('--active-left', `${offsetLeft}px`);
            paginationRef.current.style.setProperty('--active-width', `${offsetWidth}px`);
        }
    }, [activeIndex]);

    useEffect(() => {
        updateActiveBackground();

        if (document.fonts?.ready) {
            document.fonts.ready.then(updateActiveBackground);
        }

        // The labels change width with the language, but this component is
        // memo'd and updateActiveBackground is keyed on the active index alone -
        // so nothing re-measures on a language switch unless it hears it here.
        // Deferred to the next frame because the new labels are not in the DOM
        // until React has committed the re-render i18next just triggered.
        const remeasure = () => requestAnimationFrame(updateActiveBackground);
        window.addEventListener('resize', updateActiveBackground);
        i18n.on('languageChanged', remeasure);
        return () => {
            window.removeEventListener('resize', updateActiveBackground);
            i18n.off('languageChanged', remeasure);
        };
    }, [updateActiveBackground, i18n]);

    const handleNavigation = useCallback((path, index) => {
        setActiveIndex(index);
        navigate(path);
    }, [navigate]);

    return (
        // Buttons rather than divs with an onClick: this is the whole of the
        // navigation between the two pages, and as divs it was skipped by Tab
        // and deaf to Enter and Space - the only other way to /statistics is
        // the status bar's failure link, which is not there on a healthy
        // instance. Labelled with a span, since a button may not contain a
        // paragraph.
        <div className="pagination" ref={paginationRef}>
            <button
                type="button"
                className={`pagination-item${activeIndex === 0 ? " page-active" : ""}`}
                onClick={() => handleNavigation("/", 0)}
                ref={el => itemRefs.current[0] = el}
            >
                <FontAwesomeIcon icon={faListUl}/>
                <span>{t("page.overview")}</span>
            </button>
            <button
                type="button"
                className={`pagination-item${activeIndex === 1 ? " page-active" : ""}`}
                onClick={() => handleNavigation("/statistics", 1)}
                ref={el => itemRefs.current[1] = el}
            >
                <FontAwesomeIcon icon={faChartArea}/>
                <span>{t("page.statistics")}</span>
            </button>
            <div className="pagination-active-background"></div>
        </div>
    );
});

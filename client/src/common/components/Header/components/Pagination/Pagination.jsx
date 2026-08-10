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
    const { t } = useTranslation();
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
        
        window.addEventListener('resize', updateActiveBackground);
        return () => window.removeEventListener('resize', updateActiveBackground);
    }, [updateActiveBackground]);

    const handleNavigation = useCallback((path, index) => {
        setActiveIndex(index);
        navigate(path);
    }, [navigate]);

    return (
        <div className="pagination" ref={paginationRef}>
            <div
                className={`pagination-item${activeIndex === 0 ? " page-active" : ""}`}
                onClick={() => handleNavigation("/", 0)}
                ref={el => itemRefs.current[0] = el}
            >
                <FontAwesomeIcon icon={faListUl}/>
                <p>{t("page.overview")}</p>
            </div>
            <div
                className={`pagination-item${activeIndex === 1 ? " page-active" : ""}`}
                onClick={() => handleNavigation("/statistics", 1)}
                ref={el => itemRefs.current[1] = el}
            >
                <FontAwesomeIcon icon={faChartArea}/>
                <p>{t("page.statistics")}</p>
            </div>
            <div className="pagination-active-background"></div>
        </div>
    );
});

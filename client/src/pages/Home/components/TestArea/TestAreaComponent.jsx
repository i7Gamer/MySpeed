import {useContext, useEffect, useRef, useState, useCallback} from "react";
import {createPortal} from "react-dom";
import {ConfigContext} from "@/common/contexts/Config";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import Speedtest from "../Speedtest";
import {bufferbloat, getIconBySpeed, previousConnection} from "@/common/utils/TestUtil";
import {formatDay} from "@/common/utils/FormatUtil";
import {TIMEFRAME_ALL} from "@/common/utils/TimeframeUtil";
import "./styles.sass";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowUp} from "@fortawesome/free-solid-svg-icons";

const TestArea = () => {
    const config = useContext(ConfigContext)[0];
    const {speedtests, loadMoreTests, loading, hasMore, range, selectTimeframe} = useContext(SpeedtestContext);
    const [stickyDate, setStickyDate] = useState(null);
    const [showStickyDate, setShowStickyDate] = useState(false);
    const [showBackToTop, setShowBackToTop] = useState(false);
    const [initialLoadComplete, setInitialLoadComplete] = useState(false);
    const containerRef = useRef();
    const lastElementRef = useRef();

    useEffect(() => {
        if (!loading && !initialLoadComplete) {
            setInitialLoadComplete(true);
        }
    }, [loading, initialLoadComplete]);

    useEffect(() => {
        if (speedtests.length > 0) {
            const initialDate = getDateFromTest(speedtests[0]);
            setStickyDate(initialDate);
        }
    }, [speedtests]);

    const getDateFromTest = (test) => {
        const date = new Date(Date.parse(test.created));
        return date.toLocaleDateString("default", {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
    };

    const handleScroll = useCallback(() => {
        const scrollTop = Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop);

        const shouldShow = scrollTop > 50;
        setShowStickyDate(shouldShow);

        const shouldShowBackToTop = scrollTop > 300;
        setShowBackToTop(shouldShowBackToTop);

        const windowHeight = window.innerHeight;
        const documentHeight = Math.max(document.body.scrollHeight, document.body.offsetHeight,
            document.documentElement.clientHeight, document.documentElement.scrollHeight,
            document.documentElement.offsetHeight);

        const nearBottom = scrollTop + windowHeight >= documentHeight - 500;
        const atBottom = scrollTop + windowHeight >= documentHeight - 50;

        if ((nearBottom || atBottom) && hasMore && !loading && speedtests.length > 0) {
            loadMoreTests();
        }

        if (shouldShow && speedtests.length > 0) {
            const testElements = document.querySelectorAll('.speedtest');
            if (testElements.length > 0) {
                for (let i = 0; i < testElements.length; i++) {
                    const element = testElements[i];
                    const elementRect = element.getBoundingClientRect();

                    if (elementRect.top <= 200 && elementRect.bottom > 50) {
                        if (speedtests[i]) {
                            const newDate = getDateFromTest(speedtests[i]);
                            setStickyDate(newDate);
                        }
                        break;
                    }
                }
            }
        }
    }, [speedtests, stickyDate, hasMore, loading, loadMoreTests]);

    const scrollToTop = useCallback(() => {
        window.scrollTo({top: 0, behavior: 'smooth'});
        document.documentElement.scrollTo({top: 0, behavior: 'smooth'});
        document.body.scrollTo({top: 0, behavior: 'smooth'});
    }, []);

    useEffect(() => {
        let ticking = false;

        const throttledScrollHandler = () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    handleScroll();
                    ticking = false;
                });
                ticking = true;
            }
        };

        window.addEventListener('scroll', throttledScrollHandler, {passive: true});
        document.body.addEventListener('scroll', throttledScrollHandler, {passive: true});

        setTimeout(handleScroll, 100);

        return () => {
            window.removeEventListener('scroll', throttledScrollHandler);
            document.body.removeEventListener('scroll', throttledScrollHandler);
        };
    }, [handleScroll]);

    useEffect(() => {
        if (!lastElementRef.current || !hasMore || loading) return;

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMore && !loading) loadMoreTests();
        }, {threshold: 0.01, rootMargin: '200px 0px'});

        observer.observe(lastElementRef.current);

        return () => {
            observer.disconnect();
        };
    }, [hasMore, loading, loadMoreTests, speedtests.length]);

    if (Object.entries(config).length === 0) return (<></>);

    if (!initialLoadComplete || (speedtests.length === 0 && loading)) return <></>;

    /**
     * An empty list means two different things, and used to say the same
     * sentence for both. Now that the page carries a range picker, "you picked
     * a quiet week" is by far the more common - and saying "there are no tests"
     * there is both wrong and a dead end, since nothing on screen suggests the
     * range is what hid them.
     */
    if (speedtests.length === 0 && initialLoadComplete) {
        if (!range) return <h2 className="error-text">{t("test.not_available")}</h2>;

        return (
            <div className="speedtest-empty">
                <h2 className="error-text">
                    {t("test.not_available_in_range", {from: formatDay(range.from), to: formatDay(range.to)})}
                </h2>
                <button className="dialog-btn" onClick={() => selectTimeframe(TIMEFRAME_ALL)}>
                    {t("test.show_all_time")}
                </button>
            </div>
        );
    }

    return (
        <>
            {showStickyDate && stickyDate && createPortal(
                <div className="floating-date-indicator">
                    <span>{stickyDate}</span>
                </div>, document.body)}

            {showBackToTop && createPortal(
                <button className="back-to-top-button" onClick={scrollToTop} aria-label={t("common.back_to_top")}>
                    <FontAwesomeIcon icon={faArrowUp}/>
                </button>, document.body)}

            <div className="speedtest-area" ref={containerRef}>
                {speedtests.map((test, index) => {
                    const date = new Date(Date.parse(test.created));
                    const isLast = index === speedtests.length - 1;

                    return (
                        <Speedtest
                            key={test.id}
                            ref={isLast ? lastElementRef : null}
                            time={date}
                            ping={test.ping}
                            pingLevel={getIconBySpeed(test.ping, config.ping, false)}
                            jitter={test.jitter}
                            // Beside the jitter, the way the opened panel pairs
                            // them: they are the two things the line does under
                            // no load, and only one of them was legible without
                            // opening a row.
                            packetLoss={test.packetLoss}
                            // A column of its own after the ping, being the
                            // other thing latency does - what the line gains
                            // once it is busy. Graded here rather than in the
                            // row: it is derived from three of the row's
                            // columns, and one function deciding that keeps the
                            // grade the same as the panel's.
                            bufferbloat={bufferbloat(test)}
                            down={test.download}
                            downLevel={getIconBySpeed(test.download, config.download, true)}
                            up={test.upload}
                            upLevel={getIconBySpeed(test.upload, config.upload, true)}
                            error={test.error}
                            type={test.type}
                            // The columns above are what the collapsed row draws.
                            // The detail panel reads the stored row itself, so
                            // the fields only it shows are no longer unpacked
                            // one by one on the way in.
                            test={test}
                            // Newest first, so the next entry is the
                            // chronologically earlier test - what the detail
                            // view compares against.
                            previous={speedtests[index + 1]}
                            // Not the row before: that one may carry no
                            // identity, and comparing against it would report
                            // no change across the very gap one hides in.
                            previousConnection={previousConnection(speedtests, index)}
                            id={test.id}
                        />
                    );
                })}

                {loading && (
                    <div className="loading-more">
                        <p>{t("test.loading_more")}</p>
                    </div>
                )}

                {!hasMore && speedtests.length > 0 && (
                    <div className="end-of-list">
                        <p>{t("test.no_more_tests")}</p>
                    </div>
                )}
            </div>
        </>
    );
}

export default TestArea;
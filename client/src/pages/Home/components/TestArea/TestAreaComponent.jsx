import {useContext, useEffect, useRef, useState, useCallback} from "react";
import {createPortal} from "react-dom";
import {ConfigContext} from "@/common/contexts/Config";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {TargetsContext} from "@/common/contexts/Targets";
import Speedtest from "../Speedtest";
import {bufferbloat, getIconBySpeed, previousConnection} from "@/common/utils/TestUtil";
import {
    previousOfTarget, resolveLimits, roundIndexById, targetColour
} from "@/common/utils/TargetUtil";
import {formatDay, formatFullDay, formatLatency} from "@/common/utils/FormatUtil";
import {TIMEFRAME_ALL} from "@/common/utils/TimeframeUtil";
import "./styles.sass";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowUp} from "@fortawesome/free-solid-svg-icons";

// How long the floating date stays up after the last scroll event. Long enough
// to still be there through the pause in a flick, short enough that it is gone
// by the time anyone reads what it was covering.
const STICKY_DATE_LINGER_MS = 1200;

const TestArea = () => {
    const config = useContext(ConfigContext)[0];
    const {speedtests, loadMoreTests, loading, loadError, hasMore, range, selectTimeframe, reloadTests}
        = useContext(SpeedtestContext);
    const {targets, byId, selectedTarget} = useContext(TargetsContext);
    const [stickyDate, setStickyDate] = useState(null);
    const [showStickyDate, setShowStickyDate] = useState(false);
    const [showBackToTop, setShowBackToTop] = useState(false);
    const [initialLoadComplete, setInitialLoadComplete] = useState(false);
    const containerRef = useRef();
    const lastElementRef = useRef();
    const pillTimer = useRef(null);

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

    // The pill floats above rows the shared formatter renders, so it has to be
    // in the same language they are: "default" is the browser's, which on a
    // German instance in an en-US browser put an English sentence over German
    // dates.
    const getDateFromTest = (test) => formatFullDay(Date.parse(test.created));

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
        // `stickyDate` is deliberately not a dependency. This reads none of it -
        // it only ever calls setStickyDate - and listing it rebuilt the handler
        // on every date the pill showed, which tears down and re-registers the
        // scroll listeners below on each one. That is once per day boundary
        // crossed, in the middle of the scroll that is crossing them.
    }, [speedtests, hasMore, loading, loadMoreTests]);

    const scrollToTop = useCallback(() => {
        window.scrollTo({top: 0, behavior: 'smooth'});
        document.documentElement.scrollTo({top: 0, behavior: 'smooth'});
        document.body.scrollTo({top: 0, behavior: 'smooth'});
    }, []);

    useEffect(() => {
        let ticking = false;

        /**
         * The date pill is a scrolling indicator, so it leaves with the
         * scrolling.
         *
         * It says which day the rows under it belong to - a question the reader
         * has while the list is moving and not once it has stopped. Left up it
         * sits over whatever is at the top of the viewport, which on a phone is
         * the first line of a panel somebody just opened.
         */
        const keepPillUp = () => {
            clearTimeout(pillTimer.current);
            pillTimer.current = setTimeout(() => setShowStickyDate(false), STICKY_DATE_LINGER_MS);
        };

        const throttledScrollHandler = () => {
            keepPillUp();

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

        // Held so the cleanup can drop it. Left loose it outlived the effect
        // that armed it: on unmount within its 100ms it ran against listeners
        // that were already gone, and re-armed the pill timer the cleanup had
        // just cleared - so a timer survived the component by more than a
        // second, every time.
        const initialCheck = setTimeout(() => {
            handleScroll();
            // Armed here as well: a page restored halfway down its list raises
            // the pill without a scroll event ever arriving to take it away.
            keepPillUp();
        }, 100);

        return () => {
            clearTimeout(initialCheck);
            clearTimeout(pillTimer.current);
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
     * A third thing an empty list can mean, and the one it was worst at saying:
     * the request failed.
     *
     * Before its own branch this fell through to the sentence below, which on
     * all time - the default, so the ordinary case - is "There are currently no
     * tests available" as a bare heading with nothing to click. An instance
     * with years of history reported itself empty for a 500, a dropped
     * connection or a ten second timeout, and the only ways out were to change
     * the range or leave the tab and come back.
     *
     * Above the empty branch rather than beside it, and not gated on the list
     * being empty. That gate is the one the statistics page had, where it made
     * the branch unreachable once anything had loaded and a later failure drew
     * the previous range's numbers under the new range's heading.
     *
     * The server's own message, because none of the reasons are alike and only
     * it knows which one this was. An aborted request has no message of ours,
     * so that one reads as the browser's untranslated "The operation was
     * aborted" - inherited from the statistics page's pattern rather than
     * introduced here.
     */
    if (loadError) {
        return (
            <div className="speedtest-empty">
                {/* The statistics page's own shape: the reason in red at
                    reading size, not in the 26pt headline the empty states
                    wear. Those say one short sentence this page wrote; this
                    one carries whatever the server or the browser said, at
                    whatever length that turns out to be. */}
                <p className="icon-red">{loadError.message}</p>
                {/* reloadTests, not a page reload: it rebuilds the query from
                    the range and the target the page is showing, exactly as
                    the statistics page's retry does. */}
                <button className="dialog-btn" onClick={() => reloadTests()}>{t("dialog.retry")}</button>
            </div>
        );
    }

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

                    /**
                     * What this row is graded against: its own target's
                     * optimal values where set, the instance-wide settings
                     * everywhere else - including every row whose target is
                     * gone or predates targets. One resolver, shared with the
                     * detail pane, so a row cannot change colour when opened.
                     */
                    const target = byId[test.targetId];
                    const limits = resolveLimits(target, config);

                    // The dot only means something on a mixed list: two or
                    // more targets, none of them chipped down to. Filtered,
                    // every row is the chip's target and the dot says nothing.
                    const dotIndex = targets.length >= 2 && selectedTarget === null
                        ? roundIndexById(targets, test.targetId) : -1;

                    return (
                        <Speedtest
                            key={test.id}
                            ref={isLast ? lastElementRef : null}
                            time={date}
                            ping={test.ping}
                            // Graded at one decimal: not at the two the column
                            // stores, and not at the whole number the row now
                            // prints. The pane this row expands into both prints
                            // and grades the ping at one decimal, and
                            // getIconBySpeed floors a percentage - so graded
                            // anywhere else, a ping that crosses a bucket
                            // boundary on the way is green here and orange once
                            // opened. One measurement changing colour between
                            // two views of it is the worse fault; a row that
                            // shows a rounder figure than it grades is the same
                            // trade the jitter already makes in that pane.
                            pingLevel={getIconBySpeed(formatLatency(test.ping), limits.ping, false)}
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
                            downLevel={getIconBySpeed(test.download, limits.download, true)}
                            up={test.upload}
                            upLevel={getIconBySpeed(test.upload, limits.upload, true)}
                            error={test.error}
                            // Which target measured this row, as a coloured
                            // dot in the date cell - only on a mixed list,
                            // where the question arises. Null otherwise.
                            targetDot={dotIndex >= 0
                                ? {colour: targetColour(dotIndex), name: target?.name} : null}
                            // The columns above are what the collapsed row draws.
                            // The detail panel reads the stored row itself, so
                            // the fields only it shows are no longer unpacked
                            // one by one on the way in.
                            test={test}
                            // The chronologically earlier test *of this
                            // target*, not simply the next row: an unfiltered
                            // list interleaves the round's targets, and every
                            // "since last time" figure is a difference between
                            // two measurements - see previousOfTarget.
                            previous={previousOfTarget(speedtests, index)}
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
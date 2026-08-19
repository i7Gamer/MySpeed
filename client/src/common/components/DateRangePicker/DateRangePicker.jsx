import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faAnglesLeft, faAnglesRight, faCalendar, faChevronLeft, faChevronRight
} from "@fortawesome/free-solid-svg-icons";
import { t } from "i18next";
import { PICKER_TIMEFRAMES, timeframeLabelKey } from "@/common/utils/TimeframeUtil";
import { formatDay, formatMonth } from "@/common/utils/FormatUtil";
import { useClickOutside } from "@/common/hooks/useClickOutside";
import { isCurrentMonth, monthBack, monthForward, monthToShow, yearBack, yearForward } from "./calendarNav";
import "./styles.sass";

// One list of presets, wherever the picker is: each page it sits on can show
// every test it has, so each of them leads with "All time". The list used to be
// handed in by the page, back when the statistics could not draw one.
export const DateRangePicker = ({ from, to, onChange, minDate, maxDate, timeframe, onTimeframeChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [selecting, setSelecting] = useState("from");
    const [tempFrom, setTempFrom] = useState(from);
    const [tempTo, setTempTo] = useState(to);
    const [hoverDate, setHoverDate] = useState(null);
    // Seeded from the range and re-anchored whenever it changes - see the
    // effect below and monthToShow. Held in state rather than derived outright
    // because the arrows move it while the picker is open.
    const [currentMonth, setCurrentMonth] = useState(() => monthToShow(to));
    const popoverRef = useRef(null);
    const triggerRef = useRef(null);
    // The arrow that is never disabled, and whether a forward step has just
    // been made - both for recoverFromDisabledStep.
    const prevMonthRef = useRef(null);
    const steppedForward = useRef(false);

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const effectiveMaxDate = maxDate || today;
    const todayDateString = new Date().toDateString();

    /**
     * Focus back on the trigger, whenever the popover is what was holding it.
     *
     * The popover is rendered only while it is open, so every way of closing it
     * unmounts the control focus is on - Escape, the trigger toggle, choosing a
     * preset, and the second click of a day range. That leaves focus on <body>
     * and the next Tab at the top of the document.
     *
     * Reachable only because the trigger and the presets answer a keyboard now:
     * a pointer has no focus to lose. Returning it to the trigger is also the
     * whole of what a disclosure owes when it is dismissed.
     *
     * Guarded, because closing is not always the popover's doing: a click
     * outside closes it too, and focus there belongs to whatever was clicked.
     */
    const returnFocusToTrigger = useCallback(() => {
        if (popoverRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    }, []);

    // Closing halfway through a selection used to leave `selecting` on "to" and
    // a dangling tempFrom, so the next open started mid-range and the first
    // click was read as the end date.
    const closePicker = useCallback(() => {
        returnFocusToTrigger();
        setIsOpen(false);
        setSelecting("from");
        setHoverDate(null);
        setTempFrom(from);
        setTempTo(to);
    }, [from, to, returnFocusToTrigger]);

    useClickOutside(isOpen, [popoverRef, triggerRef], closePicker);

    useEffect(() => {
        const handleEscape = (event) => {
            if (event.key === "Escape") closePicker();
        };

        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, [closePicker]);

    useEffect(() => {
        setTempFrom(from);
        setTempTo(to);
        // The calendar follows the range. Without this the view was whatever
        // month the picker was first mounted with: choosing a preset moved the
        // range a year or more and left the calendar behind, describing a
        // window nothing on screen was showing.
        setCurrentMonth(monthToShow(to));
    }, [from, to]);

    // The shared formatter, which already spelled a date exactly this way in the
    // app's language rather than the browser's.
    const formatDisplayDate = (date) => {
        if (!date) return "";
        return formatDay(date);
    };

    const getDaysInMonth = (year, month) => {
        return new Date(year, month + 1, 0).getDate();
    };

    const getFirstDayOfMonth = (year, month) => {
        const day = new Date(year, month, 1).getDay();
        return day === 0 ? 6 : day - 1;
    };

    const calendarDays = useMemo(() => {
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        const daysInMonth = getDaysInMonth(year, month);
        const firstDay = getFirstDayOfMonth(year, month);
        
        const days = [];
        
        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear = month === 0 ? year - 1 : year;
        const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth);
        
        for (let i = firstDay - 1; i >= 0; i--) {
            days.push({
                day: daysInPrevMonth - i,
                date: new Date(prevYear, prevMonth, daysInPrevMonth - i),
                isCurrentMonth: false
            });
        }
        
        for (let i = 1; i <= daysInMonth; i++) {
            days.push({
                day: i,
                date: new Date(year, month, i),
                isCurrentMonth: true
            });
        }
        
        const nextMonth = month === 11 ? 0 : month + 1;
        const nextYear = month === 11 ? year + 1 : year;
        const remainingDays = 42 - days.length;
        
        for (let i = 1; i <= remainingDays; i++) {
            days.push({
                day: i,
                date: new Date(nextYear, nextMonth, i),
                isCurrentMonth: false
            });
        }
        
        return days;
    }, [currentMonth]);

    const handleDayClick = (date) => {
        if (selecting === "from") {
            setTempFrom(date);
            setSelecting("to");
            if (tempTo && date > tempTo) {
                setTempTo(null);
            }
        } else {
            if (tempFrom && date < tempFrom) {
                setTempTo(tempFrom);
                setTempFrom(date);
            } else {
                setTempTo(date);
            }
            const finalFrom = tempFrom && date < tempFrom ? date : tempFrom;
            const finalTo = tempFrom && date < tempFrom ? tempFrom : date;
            onChange(finalFrom, finalTo);
            setSelecting("from");
            returnFocusToTrigger();
            setIsOpen(false);
        }
    };

    const isInRange = (date) => {
        if (!tempFrom) return false;
        if (selecting === "to" && tempFrom && hoverDate) {
            const endDate = hoverDate;
            if (endDate < tempFrom) {
                return date >= endDate && date <= tempFrom;
            }
            return date >= tempFrom && date <= endDate;
        }
        return tempFrom && tempTo && date >= tempFrom && date <= tempTo;
    };

    const isRangeStart = (date) => {
        if (selecting === "to" && tempFrom && hoverDate && hoverDate < tempFrom) {
            return date.toDateString() === hoverDate.toDateString();
        }
        return tempFrom && date.toDateString() === tempFrom.toDateString();
    };

    const isRangeEnd = (date) => {
        if (selecting === "to" && tempFrom && hoverDate) {
            if (hoverDate < tempFrom) {
                return date.toDateString() === tempFrom.toDateString();
            }
            return date.toDateString() === hoverDate.toDateString();
        }
        return tempTo && date.toDateString() === tempTo.toDateString();
    };

    const isToday = (date) => {
        return date.toDateString() === todayDateString;
    };

    const isSelected = (date) => {
        return isRangeStart(date) || isRangeEnd(date);
    };

    const isDisabled = (date) => {
        if (minDate && date < minDate) return true;
        if (effectiveMaxDate && date > effectiveMaxDate) return true;
        return false;
    };

    const prevMonth = () => setCurrentMonth(monthBack(currentMonth));

    // Recorded because both forward arrows carry disabled={isCurrentMonthView()},
    // and pressing one is the way to reach that view - see the recovery below.
    const nextMonth = () => {
        steppedForward.current = true;
        setCurrentMonth(monthForward(currentMonth));
    };

    const prevYear = () => setCurrentMonth(yearBack(currentMonth));

    // Clamped rather than disabled short of the boundary: from December a
    // hard-disabled jump would strand the view a year back with only the
    // month arrow to walk out on - see calendarNav.
    const nextYear = () => {
        steppedForward.current = true;
        setCurrentMonth(yearForward(currentMonth, new Date()));
    };

    const isCurrentMonthView = () => isCurrentMonth(currentMonth, new Date());

    /**
     * Focus back into the calendar after a step that disabled the arrow it was
     * made on.
     *
     * Stepping forward from the month before the current one turns both forward
     * arrows off, and one of them is the control that was just pressed. Chrome
     * fires nothing when a focused element is disabled - focus becomes <body> in
     * silence, and re-enabling the arrow later does not bring it back - so
     * there is no event for the modal trap or anything else to answer, and this
     * has to be recorded by the step itself.
     *
     * Only reachable because the popover can be opened without a pointer at all
     * now: before, a keyboard never got in here to lose anything.
     *
     * The step back, because at the boundary it is the only direction left, and
     * it is the one arrow that is never disabled.
     *
     * Guarded on <body>, which is precisely the state the browser's focus fixup
     * leaves behind. Safari does not focus a button that is clicked, so there
     * the step never held focus and there is nothing to give back.
     */
    const recoverFromDisabledStep = () => {
        if (!steppedForward.current) return;

        steppedForward.current = false;

        if (isCurrentMonthView() && document.activeElement === document.body)
            prevMonthRef.current?.focus();
    };

    useEffect(() => {
        recoverFromDisabledStep();
        // A step is what this answers and currentMonth is what a step changes.
        // Listing the function would run it again on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentMonth]);

    const weekDays = [
        t("calendar.mon"),
        t("calendar.tue"),
        t("calendar.wed"),
        t("calendar.thu"),
        t("calendar.fri"),
        t("calendar.sat"),
        t("calendar.sun")
    ];

    return (
        <div className="date-range-picker">
            {/* A real button, not a div with an onClick: this is the only way
                to change the range from the interface - the presets live inside
                the popover it opens - and as a div Tab walked straight past it,
                so a keyboard-only reader was left with whatever range the page
                loaded with, on both toolbars that draw one.

                It needs no aria-label: its own text is its name, and that text
                is the current range, which is what a reader wants to hear.

                aria-expanded and nothing more. A trigger that announces a
                pop-up dialog promises one behind it, and what is behind this one
                is the popover below: no role, no name, and nothing that moves
                focus into it or holds focus there. A reader told they had opened
                a dialog would press Enter, hear "expanded", and then be told
                nothing at all. What the markup actually is - a control that
                reveals content immediately after itself, dismissed with Escape -
                is a disclosure, which aria-expanded states on its own and
                correctly. */}
            <button
                type="button"
                className="date-range-trigger"
                ref={triggerRef}
                onClick={() => isOpen ? closePicker() : setIsOpen(true)}
                aria-expanded={isOpen}
            >
                <FontAwesomeIcon icon={faCalendar} className="calendar-icon" />
                {/* A chosen preset names itself: "Last 7 days" says more than
                    the two dates it happens to resolve to today, and stays
                    true tomorrow, when those dates no longer would be. Only a
                    custom range shows its concrete dates - and with neither a
                    preset nor dates, the trigger asks for a selection. */}
                <span className="date-range-text">
                    {timeframeLabelKey(timeframe) ? (
                        t(timeframeLabelKey(timeframe))
                    ) : from && to ? (
                        <>{formatDisplayDate(from)} - {formatDisplayDate(to)}</>
                    ) : (
                        t("calendar.select_range")
                    )}
                </span>
            </button>

            {isOpen && (
                <div className="date-range-popover" ref={popoverRef}>
                    {onTimeframeChange && (
                        <div className="timeframe-presets">
                            {PICKER_TIMEFRAMES.map((preset) => (
                                <button
                                    type="button"
                                    key={preset.id}
                                    className={`timeframe-preset${timeframe === preset.id ? " preset-active" : ""}`}
                                    onClick={() => {
                                        onTimeframeChange(preset.id);
                                        setSelecting("from");
                                        returnFocusToTrigger();
                                        setIsOpen(false);
                                    }}
                                >
                                    {t(preset.labelKey)}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="calendar-selecting">
                        {t(selecting === "from" ? "calendar.select_start" : "calendar.select_end")}
                    </div>

                    {/* Double chevrons step a year, single ones a month, so a
                        window from last spring is one click away instead of
                        twelve. Both forward buttons disable together: the
                        calendar never shows a month after the current one.

                        Each is named, because each holds nothing but a
                        FontAwesome glyph and that renders aria-hidden - so all
                        four announced as an empty button, and which one stepped
                        a year rather than a month was carried entirely by how
                        many chevrons the reader could see. */}
                    <div className="calendar-nav">
                        <div className="calendar-nav-group">
                            <button type="button" className="nav-btn" onClick={prevYear}
                                    aria-label={t("calendar.previous_year")}>
                                <FontAwesomeIcon icon={faAnglesLeft} />
                            </button>
                            <button type="button" className="nav-btn" onClick={prevMonth} ref={prevMonthRef}
                                    aria-label={t("calendar.previous_month")}>
                                <FontAwesomeIcon icon={faChevronLeft} />
                            </button>
                        </div>
                        <span className="current-month">
                            {formatMonth(currentMonth)}
                        </span>
                        <div className="calendar-nav-group">
                            <button
                                type="button"
                                className="nav-btn"
                                onClick={nextMonth}
                                disabled={isCurrentMonthView()}
                                aria-label={t("calendar.next_month")}
                            >
                                <FontAwesomeIcon icon={faChevronRight} />
                            </button>
                            <button
                                type="button"
                                className="nav-btn"
                                onClick={nextYear}
                                disabled={isCurrentMonthView()}
                                aria-label={t("calendar.next_year")}
                            >
                                <FontAwesomeIcon icon={faAnglesRight} />
                            </button>
                        </div>
                    </div>

                    <div className="calendar-grid">
                        <div className="weekdays">
                            {weekDays.map((day) => (
                                <div key={day} className="weekday">{day}</div>
                            ))}
                        </div>
                        <div className="days">
                            {calendarDays.map((item, index) => (
                                <button
                                    type="button"
                                    key={index}
                                    className={`day-btn ${!item.isCurrentMonth ? "other-month" : ""} ${isInRange(item.date) ? "in-range" : ""} ${isRangeStart(item.date) ? "range-start" : ""} ${isRangeEnd(item.date) ? "range-end" : ""} ${isSelected(item.date) ? "selected" : ""} ${isToday(item.date) ? "today" : ""} ${isDisabled(item.date) ? "disabled" : ""}`}
                                    onClick={() => !isDisabled(item.date) && handleDayClick(item.date)}
                                    onMouseEnter={() => selecting === "to" && !isDisabled(item.date) && setHoverDate(item.date)}
                                    onMouseLeave={() => setHoverDate(null)}
                                    disabled={isDisabled(item.date)}
                                >
                                    {item.day}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
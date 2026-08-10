import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faAnglesLeft, faAnglesRight, faCalendar, faChevronLeft, faChevronRight
} from "@fortawesome/free-solid-svg-icons";
import { t } from "i18next";
import { PICKER_TIMEFRAMES } from "@/common/utils/TimeframeUtil";
import { isCurrentMonth, monthBack, monthForward, yearBack, yearForward } from "./calendarNav";
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
    const [currentMonth, setCurrentMonth] = useState(new Date(to || new Date()));
    const popoverRef = useRef(null);
    const triggerRef = useRef(null);

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const effectiveMaxDate = maxDate || today;
    const todayDateString = new Date().toDateString();

    // Closing halfway through a selection used to leave `selecting` on "to" and
    // a dangling tempFrom, so the next open started mid-range and the first
    // click was read as the end date.
    const closePicker = useCallback(() => {
        setIsOpen(false);
        setSelecting("from");
        setHoverDate(null);
        setTempFrom(from);
        setTempTo(to);
    }, [from, to]);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target) &&
                triggerRef.current && !triggerRef.current.contains(event.target)) {
                closePicker();
            }
        };

        const handleEscape = (event) => {
            if (event.key === "Escape") closePicker();
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [closePicker]);

    useEffect(() => {
        setTempFrom(from);
        setTempTo(to);
    }, [from, to]);

    const formatDisplayDate = (date) => {
        if (!date) return "";
        return date.toLocaleDateString(undefined, { 
            day: "2-digit", 
            month: "short", 
            year: "numeric" 
        });
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

    const nextMonth = () => setCurrentMonth(monthForward(currentMonth));

    const prevYear = () => setCurrentMonth(yearBack(currentMonth));

    // Clamped rather than disabled short of the boundary: from December a
    // hard-disabled jump would strand the view a year back with only the
    // month arrow to walk out on - see calendarNav.
    const nextYear = () => setCurrentMonth(yearForward(currentMonth, new Date()));

    const isCurrentMonthView = () => isCurrentMonth(currentMonth, new Date());

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
            <div 
                className="date-range-trigger" 
                ref={triggerRef}
                onClick={() => isOpen ? closePicker() : setIsOpen(true)}
            >
                <FontAwesomeIcon icon={faCalendar} className="calendar-icon" />
                {/* A preset can select no dates at all - "All time" is the
                    absence of a bound - so the trigger names it rather than
                    falling through to "Select date range", which reads as
                    nothing having been chosen. */}
                <span className="date-range-text">
                    {from && to ? (
                        <>{formatDisplayDate(from)} - {formatDisplayDate(to)}</>
                    ) : (
                        t(PICKER_TIMEFRAMES.find(preset => preset.id === timeframe)?.labelKey ?? "calendar.select_range")
                    )}
                </span>
            </div>

            {isOpen && (
                <div className="date-range-popover" ref={popoverRef}>
                    {onTimeframeChange && (
                        <div className="timeframe-presets">
                            {PICKER_TIMEFRAMES.map((preset) => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    className={`timeframe-preset${timeframe === preset.id ? " preset-active" : ""}`}
                                    onClick={() => {
                                        onTimeframeChange(preset.id);
                                        setSelecting("from");
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
                        calendar never shows a month after the current one. */}
                    <div className="calendar-nav">
                        <div className="calendar-nav-group">
                            <button className="nav-btn" onClick={prevYear}>
                                <FontAwesomeIcon icon={faAnglesLeft} />
                            </button>
                            <button className="nav-btn" onClick={prevMonth}>
                                <FontAwesomeIcon icon={faChevronLeft} />
                            </button>
                        </div>
                        <span className="current-month">
                            {currentMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                        </span>
                        <div className="calendar-nav-group">
                            <button
                                className="nav-btn"
                                onClick={nextMonth}
                                disabled={isCurrentMonthView()}
                            >
                                <FontAwesomeIcon icon={faChevronRight} />
                            </button>
                            <button
                                className="nav-btn"
                                onClick={nextYear}
                                disabled={isCurrentMonthView()}
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
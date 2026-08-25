import { useContext, useMemo } from "react";
import { ThemeContext } from "@/common/contexts/Theme";
import { chartThemeColors } from "@/pages/Statistics/charts/lineChartConfig";

/**
 * The chart palette, re-read whenever the theme changes.
 *
 * The resolved theme is not an argument to chartThemeColors - the colours come
 * off the document, and the provider has already stamped `data-theme` by the
 * time a child renders, deliberately during its own render rather than in an
 * effect afterwards. See ThemeContext, which explains why.
 *
 * It is the memo's key all the same. It is the thing that changed, and reading
 * the properties again is the only way to find out what they changed to. The
 * exhaustive-deps rule cannot see through getComputedStyle to a dependency that
 * is the document itself, so it calls the key unnecessary; it is the opposite.
 *
 * One hook rather than the same three lines in every chart: the disable below
 * needs an explanation, and an explanation copied three times is one that stops
 * being read.
 */
export const useChartTheme = () => {
    const {resolved} = useContext(ThemeContext);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => chartThemeColors(), [resolved]);
};

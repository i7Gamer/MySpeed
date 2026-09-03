/**
 * Keeps the document's `lang` attribute on the language the interface speaks.
 *
 * index.html ships `lang="en"` and nothing ever changed it, so a German
 * interface told screen readers, spell checkers and the browser's own
 * translation prompt that it was English - the one thing about the page that
 * every assistive tool reads first. i18n.js owns the language; this follows
 * it.
 *
 * Pure and injected so it can be run without a browser: the element is
 * whatever carries `lang`, the source is whatever emits `languageChanged`.
 */

const LANGUAGE_CHANGED = "languageChanged";

/**
 * Stamps a language on the element, or leaves it alone when there is nothing
 * to stamp - an empty or missing language must not blank the attribute the
 * markup shipped with.
 */
export const applyDocumentLanguage = (element, language) => {
    if (!element || typeof language !== "string" || language === "") return;

    element.lang = language;
};

/**
 * Applies the current language now and every later one as it changes. Returns
 * the unsubscribe, for a caller that ever needs to stop following.
 */
export const followLanguage = (i18n, element) => {
    applyDocumentLanguage(element, i18n.language);

    const onChange = (language) => applyDocumentLanguage(element, language);
    i18n.on(LANGUAGE_CHANGED, onChange);

    return () => i18n.off(LANGUAGE_CHANGED, onChange);
};

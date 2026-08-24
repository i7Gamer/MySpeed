/**
 * Which of the languages MySpeed offers a stored code actually names.
 *
 * i18n.js seeds the stored language from `navigator.language` on a first visit,
 * and wrote whatever it found there. i18next itself copes - `supportedLngs`
 * sends anything unknown to the English fallback, so the interface reads
 * correctly - but the language dialog does not: it seeds its selection from that
 * same stored value and highlights the entry matching it, so a browser set to
 * Japanese, Korean, Czech or any other language MySpeed does not ship opened the
 * dialog with nothing selected. The list then gave no sign of which language was
 * actually in use, and the reader had to pick one to find out.
 *
 * Asked on the way out of storage as well as on the way in, because a value
 * written by an earlier version is the same case and there is nothing to migrate
 * it.
 *
 * The list is passed in rather than imported: it lives in i18n.js beside the
 * flag images, which only vite can resolve, and this has to stay importable
 * everywhere - including from a test.
 */
export const supportedLanguage = (stored, languages, fallback = "en") =>
    languages.some((language) => language.code === stored) ? stored : fallback;

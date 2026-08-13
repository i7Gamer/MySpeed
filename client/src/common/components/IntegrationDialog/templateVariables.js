/**
 * The names a message template understands, and how one is written into it.
 *
 * The templates have always substituted %ping% and the rest, and nothing in the
 * interface said so: the only hint was the example in the placeholder, which
 * disappears the moment anything is typed and which named four of the two dozen
 * that work. The list itself comes from the server, on the field that accepts
 * it - a copy here would drift the first time the payload gained a column.
 */
export const variableToken = (name) => `%${name}%`;

/**
 * The template with the variable written onto the end of it.
 *
 * Appended rather than inserted at the caret: the operator has usually typed
 * the sentence first and wants the value dropped into it, and following the
 * caret would mean holding a ref to the textarea and tracking its selection
 * across re-renders for a gain nobody asked for.
 *
 * It stays on the line the template ends on - a template is often several lines
 * and a name added to the last of them belongs there - so the separator is a
 * space, and only where there is something to separate from.
 */
export const appendVariable = (template, name) => {
    const text = template ?? "";
    const token = variableToken(name);

    if (text === "") return token;

    // Nothing after a newline or an existing space: the line has already been
    // broken or the gap is already there.
    return /[\s]$/.test(text) ? `${text}${token}` : `${text} ${token}`;
};

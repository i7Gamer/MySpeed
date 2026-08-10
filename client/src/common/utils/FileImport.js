/**
 * Reading a user-chosen JSON file, with the failure paths owned.
 *
 * Both storage imports used to build the picker and the FileReader by hand and
 * run JSON.parse(reader.result) bare inside reader.onload - a truncated or
 * hand-edited backup threw an uncaught exception, so nothing on screen moved
 * and the operator was left wondering whether their history was restored.
 */
export const readAsJson = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
        try {
            resolve(JSON.parse(reader.result));
        } catch {
            reject(new Error("The file is not valid JSON"));
        }
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));

    reader.readAsText(file);
});

/**
 * Opens the browser's file picker for a single JSON file.
 *
 * Resolves null when the picker is dismissed or answers with nothing - a
 * decision, not a failure, so the caller can simply stop.
 */
export const chooseJsonFile = () => new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";

    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);

    input.click();
});

/**
 * The whole import gesture: pick a file, read it, parse it.
 *
 * Null when the picker was dismissed; throws when the chosen file cannot be
 * read or is not JSON, so the caller owns exactly one failure path.
 */
export const chooseAndReadJson = async () => {
    const file = await chooseJsonFile();
    if (file === null) return null;

    return readAsJson(file);
};

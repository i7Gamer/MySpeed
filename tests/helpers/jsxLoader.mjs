import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

/**
 * Teaches node to load the client's components, which is what lets a test run
 * one rather than read it.
 *
 * The suite reads JSX as text. That establishes presence, not behaviour, and
 * REVIEW_1.3.5.md records what presence cannot see: three regressions shipped
 * past 3,775 green tests, each living in a hook the suite scanned and never
 * executed. Only useModalFocus has since been driven for real, against a fake
 * DOM built by hand for it alone (tests/helpers/modalDom.js). Every other
 * hook, context and menu still has nothing that would catch a behavioural
 * break - and the contexts are .jsx, which that hand-built route cannot even
 * import.
 *
 * So this is the same seam the alias resolver already sits on, one hook
 * further along: the resolver finds the file, this one turns it into something
 * node will evaluate. JSX goes through esbuild with the automatic runtime,
 * which is what @vitejs/plugin-react gives the real build. A stylesheet or an
 * image import answers an empty module - a component's sass is the bundler's
 * business, and a test asserting on behaviour has no use for it. Each stub is
 * fidelity deliberately given away, and the list is short on purpose: a test
 * that needs more than this is asking to render a page, and a page is where
 * jsdom stops being a browser.
 */

const STYLES = /\.(sass|scss|css)$/;
const ASSETS = /\.(webp|png|jpe?g|gif|svg)$/;

const I18N_DOUBLE = new URL("./i18nDouble.js", import.meta.url).href;

export async function load(url, context, next) {
    // The browser's i18n bootstrap, answered by the double beside this file -
    // see i18nDouble.js for what the real one does that node cannot.
    if (url.endsWith("/client/src/i18n.js"))
        return {format: "module", shortCircuit: true,
            source: `export * from ${JSON.stringify(I18N_DOUBLE)};\n`
                + `export {default} from ${JSON.stringify(I18N_DOUBLE)};\n`};

    if (STYLES.test(url))
        return {format: "module", source: "export default {};", shortCircuit: true};

    if (ASSETS.test(url))
        return {format: "module", source: "export default \"\";", shortCircuit: true};

    if (url.endsWith(".jsx")) {
        const file = fileURLToPath(url);
        const {code} = await transform(await readFile(file, "utf8"),
            {loader: "jsx", jsx: "automatic", format: "esm", sourcefile: file});

        return {format: "module", source: code, shortCircuit: true};
    }

    // The client's plain modules are ES modules under a package.json that does
    // not say so - vite never needed telling. Said here, so node evaluates them
    // as such instead of parsing each one twice and warning about it.
    if (url.includes("/client/src/") && url.endsWith(".js"))
        return next(url, {...context, format: "module"});

    // A JSON import the bundler takes bare, which node wants attributed.
    if (url.endsWith(".json"))
        return next(url, {...context, importAttributes: {type: "json"}});

    return next(url, context);
}

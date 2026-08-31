import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const COMPONENTS = path.join(ROOT, "client", "src", "common", "components");

/**
 * The dialogs behind the settings menu, and the things they should agree on.
 *
 * They had drifted: five said 28rem, language said 22 and preferences 26, and
 * none of them recorded why. A reader opening two of them in a row saw the
 * dialog change size for no reason they could name, and the narrowest was the
 * one with fifteen rows in it.
 *
 * The list is read from the menu rather than written here, so a dialog added to
 * that menu later is held to the same agreement without anyone remembering.
 */
describe("every dialog in the settings menu", () => {
    const dropdown = withoutJsComments(readSource("client/src/common/components/Dropdown/DropdownComponent.jsx"));

    /*
     * Excluded, each for a stated reason rather than because it failed:
     * storage is a tabbed table and genuinely wider, integration and welcome
     * size to their content, and the targets manager is a list whose rows
     * each carry a name, a summary and five controls - at the shared width
     * the controls fold under the text on every row. The exclusions are named
     * so that adding one is a decision somebody writes down.
     */
    const SIZES_TO_ITS_CONTENT = ["StorageDialog", "IntegrationDialog", "WelcomeDialog",
        "TargetsDialog"];

    const opened = () => [...new Set([...dropdown.matchAll(/setShow(\w+Dialog)\(true\)/g)]
        .map(([, name]) => name))].filter((name) => !SIZES_TO_ITS_CONTENT.includes(name));

    /**
     * The class the dialog puts on itself, and the width the compiled sheet
     * gives that class.
     *
     * Read from the output rather than from the source: a `width:` in a .sass
     * file is only the dialog's own if it is at the right nesting depth, and a
     * check that guesses at indentation reports every field and swatch inside
     * the dialog as well. What matters is the rule the browser applies.
     */
    const declaredWidth = (component) => {
        const jsx = readSource(`client/src/common/components/${component}/${component}.jsx`);
        // The class on the Dialog element itself, not the first class in the
        // file that happens to contain "dialog" - a `dialog-value` span in a
        // confirm description used to win this race.
        const [, selector] = /<Dialog[^>]*className="([a-z-]*dialog[a-z-]*)"/.exec(jsx) ?? [];

        if (!selector) return null;

        // Its own stylesheet, not default.sass: a component's styles reach the
        // page through its JSX importing them, so they are nowhere in the one
        // sheet App.jsx loads.
        const styles = compile(`common/components/${component}/styles.sass`);
        const at = styles.indexOf(`.${selector} {`);

        if (at === -1) return null;

        return (/width:\s*([^;]+);/.exec(styles.slice(at, styles.indexOf("}", at))) ?? [])[1] ?? null;
    };

    it("finds the dialogs to check", () => {
        assert.ok(opened().length >= 6, `only found ${opened().length} settings dialogs in the menu`);
        assert.ok(opened().every((name) => declaredWidth(name) !== null),
            `could not read a width for ${opened().filter((name) => declaredWidth(name) === null).join(", ")}`);
    });

    it("is the same width as the one beside it in the menu", () => {
        const widths = opened().map((name) => [name, declaredWidth(name)]);
        const [, shared] = widths[0];

        assert.deepEqual(widths.filter(([, width]) => width !== shared).map(([name]) => name), [],
            `these differ from ${shared}, so the menu changes size between them`);
    });
});

/**
 * The width a dialog asks for is the width it gets.
 *
 * `.dialog` carries a shared max-width so that a dialog stating no width of its
 * own cannot span a wide screen. That is a floor against accidents, not a width
 * policy - but it was written as `min(500px, 90vw)`, which is a policy, and it
 * quietly outranked every dialog that asked for more. Three were let out by
 * name; the targets manager was not, so it declared 34rem, recorded in a comment
 * why it needed to be wider than the rest, and was drawn at 500px.
 *
 * Nothing could see it. The declaration and the cap are in different files, the
 * cap's escape list is in neither dialog's stylesheet, and settingsDialogs above
 * excuses the manager from the width check entirely - so the one dialog whose
 * width was being overridden was also the one nothing was measuring.
 *
 * So the shared rule keeps the dialog on the screen and nothing else: it may
 * measure itself against the viewport, and may not carry a length that competes
 * with what a stylesheet has deliberately said.
 */
describe("the shared dialog rule", () => {
    const css = compile("common/contexts/Dialog/styles.sass");

    const dialogRule = () => {
        const at = css.indexOf(".dialog {");

        assert.notEqual(at, -1, "the shared dialog rule is gone");
        return css.slice(at, css.indexOf("}", at));
    };

    it("keeps a dialog on the screen", () => {
        assert.match(dialogRule(), /max-width:/, "a dialog with no width of its own is unbounded");
    });

    it("measures that against the viewport rather than against a number", () => {
        const [, cap] = /max-width:\s*([^;]+);/.exec(dialogRule()) ?? [];

        assert.doesNotMatch(cap, /\d\s*(px|rem|em)\b/,
            `the shared cap is "${cap}", which silently overrides any dialog that asks for more `
            + "- and the dialog doing the asking has no way to see it");
    });

    /**
     * The escape hatch that cap needed. Three dialogs were listed by name to
     * be let past it, which is a list that has to be remembered: the manager
     * was given a wider width and never added, and the miss was invisible.
     */
    it("needs no list of dialogs excused from it", () => {
        assert.doesNotMatch(css, /&\.[a-z-]+-(?:dialog|wrapper)[a-z-]*,?\s*\n\s*(?:&[^\n]*\n\s*)*max-width/,
            "a cap that some dialogs have to be named out of is a rule nobody can apply from "
            + "the file that declares a width");
    });
});

/**
 * The manager and the editor it opens are one screen's worth of the same job,
 * and the editor is reached by a button inside the manager. Drawn narrower, it
 * makes the dialog jump inward when it opens and outward when it closes.
 */
describe("the targets manager and its editor", () => {
    const css = compile("common/components/TargetsDialog/styles.sass");

    const widthOf = (selector) => {
        const at = css.indexOf(`.${selector} {`);

        assert.notEqual(at, -1, `${selector} has no rule`);
        return (/width:\s*([^;]+);/.exec(css.slice(at, css.indexOf("}", at))) ?? [])[1];
    };

    it("are the same width as each other", () => {
        assert.equal(widthOf("provider-dialog-wrapper"), widthOf("targets-dialog-wrapper"),
            "the dialog changes size when the editor opens over the list that opened it");
    });

    /**
     * The rows carry a label and a value side by side, and the values are the
     * long ones: an interface name with its address, a server with its sponsor
     * and city, a backend URL. Pinned to one width they could not use the room
     * the dialog was widened to give them - the interface select showed 224px
     * of a value needing 311, and of options needing 415.
     */
    it("lets a field use the width the dialog has", () => {
        const at = css.indexOf(".provider-input {");
        assert.notEqual(at, -1, "the shared field rule is gone");

        const rule = css.slice(at, css.indexOf("}", at));

        assert.doesNotMatch(rule, /max-width:\s*\d+(?:\.\d+)?(?:rem|px)/,
            "the field is pinned to a fixed width, so a wider dialog cannot help it");
        assert.match(rule, /flex:/,
            "the field takes no share of the row, so it cannot grow into it");
    });

    /**
     * In the editor the fields sit under one another, so a reader sees them as
     * a column - and a column whose members are different lengths reads as
     * ragged rather than as deliberate. Taking whatever its own label left over
     * gave them four widths within 48px of each other, which is close enough to
     * look like a mistake and far enough to see.
     *
     * The interface select in the manager is the opposite case: one row, alone,
     * holding a value that needed 311px and options needing 415. It keeps the
     * width of its dialog, which is what the commit before this one gave it.
     */
    it("draws every field in the editor at one width", () => {
        const at = css.indexOf(".provider-dialog-wrapper .provider-input {");
        assert.notEqual(at, -1, "the editor no longer sizes its fields together");

        const rule = css.slice(at, css.indexOf("}", at));
        const [, grow] = /flex:\s*(\d+)/.exec(rule) ?? [];

        assert.equal(grow, "0",
            "a field that grows takes what its row leaves it, which is a different width per row");
        assert.match(rule, /flex:\s*0\s+0\s+\d/,
            "the fields need a shared basis, not a share of each row");
    });
});

/**
 * The rows of the target editor, and which of them get an edge drawn round
 * them.
 *
 * A setting is a label and a control with the dialog's width between them, and
 * something has to tie the two together over that distance. For most of these
 * rows the control does it itself: an input and a select draw their own border,
 * so the row already ends in a visible object and the eye carries from the
 * words to it. Drawing a card round those puts a rounded rectangle fourteen
 * pixels outside another rounded rectangle, which reads as heavier without
 * saying anything new.
 *
 * A toggle brings no edge. It is a small pill against the far margin, and the
 * gap between it and its label is the void it looks like. That is the row that
 * needs the border, and the provider cards immediately above are where its
 * shape comes from.
 *
 * So: a row is carded when its control has no border of its own.
 */
describe("a setting row in the target editor", () => {
    const settings = compile("common/components/TargetsDialog/styles.sass");
    const cards = compile("common/components/SelectableOption/styles.sass");

    const ruleFor = (css, selector) => {
        const at = css.indexOf(`${selector} {`);

        assert.notEqual(at, -1, `${selector} has no rule`);
        return css.slice(at, css.indexOf("}", at));
    };

    const value = (rule, property) =>
        (new RegExp(`(?:^|[;{])\\s*${property}:\\s*([^;]+)`).exec(rule) ?? [])[1]?.trim();

    /**
     * Read off the cards rather than written here, so the two cannot drift:
     * a change to the provider card's shape is a change to the switch rows.
     */
    for (const property of ["border", "border-radius", "padding"]) {
        it(`gives a switch row the provider card's ${property}`, () => {
            assert.equal(value(ruleFor(settings, ".provider-setting-switch"), property),
                value(ruleFor(cards, ".selectable-option"), property),
                `the switch rows and the cards above them disagree about ${property}`);
        });
    }

    it("draws no second border round a field that has one already", () => {
        const rule = ruleFor(settings, ".provider-setting");

        assert.equal(value(rule, "border"), undefined,
            "an input and a select draw their own edge; a card around them is a box in a box");
        assert.equal(value(rule, "padding"), undefined,
            "padding here insets the field from a border the row does not have");
    });

    /**
     * The label has to take the slack, not the gap: with `space-between` doing
     * it, the words ended where they ended and the control sat at the far side
     * of a void. This holds for both kinds of row.
     */
    it("gives the words the slack rather than the space between them", () => {
        const rule = ruleFor(settings, ".provider-setting-label");

        assert.match(value(rule, "flex") ?? "", /^1\s/,
            "the label does not take the row's spare width, so it opens a gap instead");
        assert.doesNotMatch(ruleFor(settings, ".provider-setting"), /justify-content:\s*space-between/,
            "space-between pushes the pair apart across the whole row");
    });

    /**
     * The class is written on the row rather than found with :has(), which
     * nothing in this client uses yet: a reader adding a row sees in the JSX
     * which kind it is, instead of it being decided for them by a selector in
     * another file.
     */
    it("is marked as a switch row where the row is written", () => {
        const jsx = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");
        const rows = [...jsx.matchAll(/className="provider-setting[^"]*"/g)].map(([match]) => match);
        const switches = rows.filter((row) => row.includes("provider-setting-switch"));

        // Alerts, own optimal values, and the baseline. A count rather than a
        // list, because the point is that the class is written where the row
        // is - a row that grows a toggle and forgets it is what this notices.
        assert.equal(switches.length, 3,
            `${switches.length} rows are marked as switch rows; the editor has three toggle rows`);
    });

    /**
     * And the third toggle is deliberately not one of them. The UDP switch
     * sits inside the run-settings row rather than beside it, so borrowing
     * this class would draw a second border within the first - the row style
     * carries its own padding and edge, which is the whole of what it is for.
     */
    it("keeps the toggle nested in a row out of the row style", () => {
        const jsx = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");

        assert.match(jsx, /className="target-tuning-switch"/,
            "the run-settings toggle no longer names itself");
        assert.doesNotMatch(jsx, /className="provider-setting-switch target-tuning-switch"/,
            "the nested toggle took the bordered row style");
    });

    /**
     * And that row stacks, because it is the one row whose control is not a
     * control but three of them: a label, two number fields, and the mode
     * toggle underneath.
     *
     * `.provider-setting` is a row - a label on the left and one field on the
     * right - which is right for every other setting here and wrong for this
     * one. Laid out as a row, the three blocks became three columns: the
     * fields and the switch took an equal share each, the label was squeezed
     * to 52px with its own heading 64px wide overflowing it, and the two
     * number fields wrapped into a stack tall enough that "Run settings" was
     * drawn across "Parallel streams".
     *
     * The modifier class was already written on the row in the JSX for this,
     * and the rule it names was never written - so the class said the row was
     * special and the stylesheet treated it like every other. Both halves of
     * the pair are read here, because the class alone changes nothing and the
     * rule alone is dead.
     */
    it("stacks the run-settings row rather than laying it out as three columns", () => {
        const jsx = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");
        const rule = ruleFor(settings, ".target-tuning-setting");

        assert.match(jsx, /className="provider-setting target-tuning-setting"/,
            "the run-settings row no longer marks itself as the one that stacks");
        assert.notEqual(rule, null,
            ".target-tuning-setting is named in the JSX and styled nowhere, so the row is laid "
            + "out as three columns and the label is crushed under its own heading");
        assert.match(rule, /flex-direction:\s*column/,
            "the row lays its label, its fields and its toggle out side by side");
        assert.match(rule, /align-items:\s*stretch/,
            "centred items leave the full-width fields and toggle sized to their content");
    });
});

/**
 * The list that scrolls inside the language dialog.
 *
 * Raising it to 28rem made the dialog taller than a laptop viewport leaves
 * room for, which handed `.dialog-main` - itself overflow auto - a few pixels
 * of slack. A wheel at the list's bottom then chains into that slack: the
 * whole dialog shifts up, the last language's bottom border slides under the
 * dialog's edge, and scrolling back has to unwind the dialog before the list
 * will sit at its real bottom again. Measured at 1280x620: 20px of slack, and
 * the last row's border cropped by exactly the chained pixel.
 *
 * Two rules close both halves: the height yields to the viewport, so the
 * dialog fits and the slack never exists - and the list contains its own
 * overscroll, so whatever slack a window still produces cannot be reached
 * from inside the list.
 */
describe("the language list", () => {
    const css = compile("common/components/LanguageDialog/styles.sass");

    const listRule = () => {
        const at = css.indexOf(".language-list {");

        assert.notEqual(at, -1, "the language list has no rule in its stylesheet");
        return css.slice(at, css.indexOf("}", at));
    };

    it("keeps its wheel to itself at its ends", () => {
        assert.match(listRule(), /overscroll-behavior:\s*contain/,
            "a wheel at the list's end scrolls the dialog behind it, which hides the last row's border");
    });

    /**
     * The other way the border went missing, and the one that needed a real
     * device-pixel-ratio to see: scrollTop and scrollHeight clamp on integers
     * while fractional scaling lays the rows out on fractions, so at 125% and
     * 150% the bottom of the last row sat ~0.3 CSS px below the scrollport's
     * crop at maximum scroll - permanently, with the hover repaint deciding
     * whether the straddling border was drawn or not. Slack under the last row
     * means the clamp error eats padding, never border.
     */
    it("keeps the last row's border off the crop line", () => {
        assert.match(listRule(), /padding-bottom:\s*0\.25rem/,
            "without bottom slack, fractional-DPR scroll clamping clips the last row's border");
    });

    it("yields its height to the viewport before the dialog has to scroll", () => {
        // The compiler may drop the redundant calc() inside min(), so the
        // assertion reads the mechanism - a viewport term minus an allowance -
        // rather than one spelling of it.
        assert.match(listRule(), /max-height:\s*min\(28rem,\s*(?:calc\()?100dvh\s*-\s*\d/,
            "a fixed max-height makes the dialog outgrow short viewports, which is where the slack comes from");
    });
});

/**
 * The scrollbar, which had no visible thumb anywhere in the app.
 *
 * $light-gray is a border colour, and as a thumb it measured 1.30:1 against a
 * dialog's surface - a scrollbar is a control, which answers to 3:1. Under
 * 730px it was worse than invisible: a 5px bar with a 3px inset on each side
 * leaves the thumb less than nothing to be drawn in, so there was no position
 * indicator at all.
 *
 * The colour is held by paletteContrast.test.js, which measures it against
 * every surface of every palette. What is held here is the geometry, and that
 * one rule serves every surface rather than each dialog writing its own.
 */
describe("the scrollbar", () => {
    const css = compile("common/styles/default.sass");

    const ruleFor = (selector, from = 0) => {
        const at = css.indexOf(`${selector} {`, from);
        return at === -1 ? null : css.slice(at, css.indexOf("}", at));
    };

    it("leaves room for the thumb inside the bar", () => {
        const widths = [...css.matchAll(/::-webkit-scrollbar \{[^}]*?width:\s*(\d+)px/g)].map(([, px]) => Number(px));
        const insets = [...css.matchAll(/::-webkit-scrollbar-thumb \{[^}]*?border(?:-width)?:\s*(\d+)px/g)]
            .map(([, px]) => Number(px));

        assert.ok(widths.length >= 2, `only found ${widths.length} scrollbar widths`);
        assert.ok(insets.length >= 1, "the thumb states no inset");
        assert.ok(Math.min(...widths) > 2 * Math.max(...insets),
            `a ${Math.min(...widths)}px bar cannot hold a thumb inset by ${Math.max(...insets)}px on each side`);
    });

    it("does not paint a surface it cannot know", () => {
        const thumb = ruleFor("::-webkit-scrollbar-thumb");

        assert.match(thumb, /background-clip:\s*padding-box/,
            "without this the inset has to be painted in some surface's colour, and a dialog is not the page");
        assert.match(ruleFor("::-webkit-scrollbar-track"), /background:\s*(transparent|none|0 0)/);
    });

    /** Firefox has none of the -webkit- rules and answers to these instead. */
    it("is themed for a browser without ::-webkit-scrollbar", () => {
        assert.match(css, /@supports not selector\(::-webkit-scrollbar\)/);
        assert.match(css, /scrollbar-color:\s*var\(--scrollbar-thumb\)/);
    });

    it("is stated once rather than per dialog", () => {
        const own = fs.readdirSync(COMPONENTS)
            .filter((name) => fs.existsSync(path.join(COMPONENTS, name, "styles.sass")))
            .filter((name) => /::-webkit-scrollbar/.test(fs.readFileSync(path.join(COMPONENTS, name, "styles.sass"), "utf8")));

        assert.deepEqual(own, [],
            "these carry their own scrollbar rules, which is how the colour got fixed everywhere except here");
    });
});

/**
 * The three optimal values, side by side.
 *
 * Each column was as wide as whichever was wider, its 7.5rem input or its
 * header - and the row was three of those plus two 1.5rem gaps, which comes to
 * exactly the 408px the dialog has inside its padding. Zero slack by
 * construction, so English spilled 2px past each edge on sub-pixel rounding
 * alone: the left border of the ping field and the right border of the upload
 * field were cut off by the dialog.
 *
 * Every other language made it worse, because the header carries the unit and
 * the unit is translated. Measured against the real render: French spilled 50px
 * each side, Ukrainian 46, Swedish 27, Norwegian 11, Polish 8, Russian 4. Eight
 * of the fourteen languages checked were cut.
 *
 * Widening alone could not fix that - French needs 508px of content, so the
 * shared settings width would have had to reach 34rem to hold it, and the next
 * translation would start the argument again. So the columns share the row
 * instead of adding up to it: three equal parts of whatever width there is,
 * with the header free to wrap inside its part. The row can then never be wider
 * than what holds it, in any language, and the extra width the dialog was given
 * is what keeps the wrapping rare rather than what prevents the overflow.
 */
describe("the optimal values row", () => {
    const css = compile("common/components/OptimalValuesDialog/styles.sass");

    const ruleFor = (selector) => {
        const at = css.indexOf(`${selector} {`);

        assert.notEqual(at, -1, `${selector} has no rule`);
        return css.slice(at, css.indexOf("}", at));
    };

    it("shares the row out rather than adding up to it", () => {
        const rule = ruleFor(".optimal-values-content .optimal-values-speeds .optimal-values-speed");

        assert.match(rule, /flex:\s*1\s+1\s+0/,
            "a column sized to its own content makes the row as wide as the three of them together");
        assert.match(rule, /min-width:\s*0/,
            "without this a flex item refuses to shrink past its content, which is the overflow");
    });

    it("lets the field fill the column it is given", () => {
        const rule = ruleFor(
            ".optimal-values-content .optimal-values-speeds .optimal-values-speed input");

        assert.match(rule, /width:\s*100%/,
            "a field pinned in rem sets the column's width instead of taking it");
    });
});

/**
 * The buttons down the right of the storage dialog.
 *
 * Each was as wide as its own label, which put Save at 70px, CSV at 67, JSON at
 * 77, Import at 79 and Delete at 80 - a 13px spread down one column, close
 * enough to read as a mistake rather than as a difference.
 *
 * The floor is measured rather than chosen: across the twenty-three locales the
 * widest stable label is Italian's "Importazione" at 143px, so 9rem holds every
 * one of them and the column is even in every language. The two transient
 * labels - "Saving..." and the delete confirmation - are allowed past it, since
 * a button that visibly changes while it is armed is the point of them.
 */
describe("the storage dialog's buttons", () => {
    const css = compile("common/components/StorageDialog/styles.sass");

    it("share one width", () => {
        const at = css.indexOf(".storage-row-actions .dialog-btn {");
        assert.notEqual(at, -1, "the buttons are sized one at a time again");

        const [, width] = /min-width:\s*([\d.]+)rem/.exec(css.slice(at, css.indexOf("}", at))) ?? [];

        assert.ok(width !== undefined, "no shared floor, so each button is as wide as its own word");
        assert.ok(parseFloat(width) >= 9,
            `${width}rem is under the 143px the widest translated label needs`);
    });
});

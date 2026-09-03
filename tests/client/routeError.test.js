import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { act, cleanup, click, createElement, render, settle, window } from "../helpers/renderHarness.js";
import RouteError from "@/pages/RouteError";

/**
 * The page the whole application falls back to, run rather than read.
 *
 * It is App's one errorElement, so it stands for two quite different failures:
 * an address that matches no route, which react-router raises as a 404
 * ErrorResponse, and anything a page throws while rendering, which arrives as
 * the error itself. The two are told apart by isRouteErrorResponse, and what
 * hangs off that distinction is not only the wording - a 404 offers no reload,
 * because reloading an address that does not exist gives the same page back.
 *
 * useRouteError only answers under a data router, so MemoryRouter is not
 * enough here: these build a real router with createMemoryRouter and let it
 * produce the error, rather than handing the component a value by hand.
 */
afterEach(cleanup);

// The harness's window is what the click helper builds its events from, and
// one test below stands a substitute in front of it - see there.
afterEach(() => assert.equal(globalThis.window, window, "a test left a substitute window installed"));

/*
 * Both React and react-router report a caught render error on console.error,
 * whatever the boundary then does with it, and they report it from wherever
 * the work happened to be scheduled rather than inside the call that started
 * it. Deliberately throwing at a boundary is the whole subject here, so the
 * channel is recorded for the length of the file instead of being followed
 * around it - and put back afterwards, so nothing else in the run goes quiet.
 */
const reported = [];
const realConsoleError = console.error;
console.error = (...args) => reported.push(args);

after(() => { console.error = realConsoleError; });

const NOT_FOUND_PATH = "/does-not-exist";

/** A route tree whose only page is fine, entered at an address it does not cover. */
const notFoundRouter = () => createMemoryRouter([
    {path: "/", element: createElement("div", {id: "home"}, "home"), errorElement: createElement(RouteError)}
], {initialEntries: [NOT_FOUND_PATH]});

const Throws = () => { throw new Error(THROWN_MESSAGE); };

const THROWN_MESSAGE = "boom";

/** And one whose page throws, which is the other half of what this element catches. */
const thrownRouter = () => createMemoryRouter([
    {path: "/", element: createElement(Throws), errorElement: createElement(RouteError)}
], {initialEntries: ["/"]});

const mount = (router) => {
    const mounted = render(createElement(RouterProvider, {router}));
    const page = mounted.container.querySelector(".route-error-page");

    assert.ok(page, "the error page did not render");
    return {...mounted, router, page};
};

/** The page's buttons, by the label a reader sees. */
const buttonNamed = (page, text) =>
    [...page.querySelectorAll("button")].find((button) => button.textContent.trim() === text);

describe("the route error page on an address that matches nothing", () => {
    it("names the status and says the page is not there", () => {
        const {page} = mount(notFoundRouter());

        assert.equal(page.querySelector(".route-error-title").textContent, "404");
        assert.equal(page.querySelector(".route-error-subtitle").textContent, "Page not found");
    });

    /*
     * The one behavioural difference between the two cases: an address that
     * does not exist answers the same on a reload, so offering one is an
     * invitation to try the thing that just failed.
     */
    it("offers no reload, which would fetch the same missing page again", () => {
        const {page} = mount(notFoundRouter());

        assert.equal(buttonNamed(page, "Reload Page"), undefined,
            "the not-found page offers to reload an address that will not appear");
    });

    it("shows no thrown message, because nothing was thrown", () => {
        const {page} = mount(notFoundRouter());

        assert.equal(page.querySelector(".route-error-details"), null);
    });

    it("takes the reader home", async () => {
        const {page, router} = mount(notFoundRouter());

        assert.equal(router.state.location.pathname, NOT_FOUND_PATH, "the router did not start where it was sent");

        click(buttonNamed(page, "Back to Home"));
        await settle();

        assert.equal(router.state.location.pathname, "/", "the home button left the reader on the missing address");
    });
});

describe("the route error page on a page that threw", () => {
    it("says something went wrong rather than naming a status", () => {
        const {page} = mount(thrownRouter());

        assert.equal(page.querySelector(".route-error-title").textContent, "Oops!");
        assert.equal(page.querySelector(".route-error-subtitle").textContent, "Something went wrong");
    });

    it("shows the thrown message as preformatted text", () => {
        const {page} = mount(thrownRouter());
        const details = page.querySelector("pre.route-error-details");

        assert.ok(details, "the error's own message is nowhere on the page");
        assert.equal(details.textContent, THROWN_MESSAGE);
    });

    /**
     * jsdom's location is unforgeable - reload can be neither redefined nor
     * assigned - so the substitute goes one level up: the component reads
     * `window` as a global, and the harness installs that global itself. An
     * object inheriting from the real window answers everything else exactly as
     * before, and is put back the moment the click has been handled.
     */
    it("reloads the page on request", () => {
        const {page} = mount(thrownRouter());
        const reloads = [];

        const real = globalThis.window;
        const substitute = Object.create(real);
        Object.defineProperty(substitute, "location", {value: {reload: () => reloads.push(1)}});
        globalThis.window = substitute;

        try {
            act(() => buttonNamed(page, "Reload Page")
                .dispatchEvent(new real.MouseEvent("click", {bubbles: true, cancelable: true})));
        } finally {
            globalThis.window = real;
        }

        assert.equal(reloads.length, 1, "the reload button did not reload the page");
    });

    it("also offers the way home", async () => {
        const {page, router} = mount(thrownRouter());

        click(buttonNamed(page, "Back to Home"));
        await settle();

        assert.equal(router.state.location.pathname, "/");
    });

    // Not silence: the throw is meant to be reported, and a boundary that
    // swallowed it entirely would be the other failure worth hearing about.
    it("leaves the error on the console for whoever is watching", () => {
        mount(thrownRouter());

        assert.ok(reported.some((args) => args.some((arg) => String(arg?.message ?? arg).includes(THROWN_MESSAGE))),
            "the caught error was never reported anywhere");
    });
});

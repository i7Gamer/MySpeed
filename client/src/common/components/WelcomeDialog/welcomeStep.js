/**
 * Where the welcome wizard is, and whether it may leave.
 *
 * Pure and apart from the dialog, the way welcomeOutcome.js is: this decides
 * whether a first-run setup can be completed at all, and the only way to be
 * sure of that is to hand it a step and a provider and ask.
 */

import {iperfHostAccepted, requiresEndpoint} from "../TargetsDialog/providerFields.js";

/** The step the wizard opens on: the greeting, before anything is asked. */
export const FIRST_STEP = 1;

/** The step the provider cards are on. */
export const PROVIDER_STEP = 2;

/**
 * The card a wizard that has not been answered yet offers.
 *
 * Spelled the same as the licence check in lastStep below, and deliberately
 * not shared with it: that one asks which provider has a licence to show, this
 * one asks which card is highlighted before anything has been chosen. Two
 * rules that happen to name the same provider today, and either could move
 * without the other.
 */
export const DEFAULT_PROVIDER = "ookla";


const THRESHOLDS_STEP = 3;
const LICENCE_STEP = 4;

/**
 * The wizard's last step for a provider.
 *
 * Ookla is the one with a licence to show, so it is the one with a fourth
 * step. Read from here rather than written as `provider === "ookla" ? 4 : 3`
 * beside both the step counter and the button that has to know whether it says
 * "continue" or "done" - two copies of one rule, either of which can be the
 * one that is updated.
 */
export const lastStep = (provider) => provider === "ookla" ? LICENCE_STEP : THRESHOLDS_STEP;

/**
 * The whole of what an opening wizard shows.
 *
 * One function rather than six useState initialisers, because this dialog is
 * mounted for the life of the application. TargetsContext renders
 * `<WelcomeDialog open={welcomeShown}/>` with no `{open && ...}` guard - as
 * every dialog in this client is rendered - and DialogContext's
 * `if (!visible) return null` unmounts only the dialog's *children*, so the
 * hooks live above that boundary and survive every close.
 *
 * The open-time sync re-seeded the three thresholds and nothing else. So an
 * operator who set one instance up and then switched to a second, freshly
 * installed node - NodeContainer switches without a page load, TargetsContext
 * drops its list, the refetch comes back empty and the wizard opens again -
 * was dropped straight onto the *last* step carrying the first node's provider
 * and, for iperf3, the first node's host. No chooser, no Back button, and the
 * one button on screen reading Done, which wrote node A's answers onto node B.
 *
 * Pure and exported because the suite cannot execute JSX: what a reopened
 * wizard shows is a decision, and the only way to be sure of it is to ask.
 */
export const welcomeSeed = (config) => ({
    step: FIRST_STEP,
    provider: DEFAULT_PROVIDER,
    endpoint: "",
    // parseFloat, because finish() writes all three back unconditionally: an
    // integer parse rewrote any fractional threshold the wizard was merely
    // clicked past - "25.9" went back as 25, and "0.4", the recommended ping on
    // a fast line, went back as 0, a threshold no latency is ever under.
    // `|| 0` covers a config that has not been fetched yet, which is exactly
    // the state this dialog first mounts against.
    ping: parseFloat(config.ping) || 0,
    download: parseFloat(config.download) || 0,
    upload: parseFloat(config.upload) || 0
});


/**
 * Whether the wizard may move on from the step it is on.
 *
 * The chooser draws whatever is in the shared provider list, and one of those
 * providers cannot measure without an address: the server refuses an iperf3
 * target with no host, so Done threw and toasted and returned before the
 * dialog closed. This is the one dialog mounted `disableClose` and the only
 * one with no way back to a previous step, so an operator who picked that card
 * on a fresh install was held behind a button that failed every time - naming
 * a field the wizard had never shown them - until they reloaded the page.
 *
 * Asked as "may this step be left" rather than "is the address filled in", so
 * the next provider that needs a value of its own is refused here by the same
 * rule instead of being discovered by whoever installs it.
 */
export const canAdvance = ({step, provider, endpoint}) =>
    step !== PROVIDER_STEP
    || !requiresEndpoint(provider)
    // Held to the shape the server holds it to, not merely to being filled in.
    // Emptiness closed half the trap this function was written for: an address
    // the server refuses for shape - a pasted URL, a port of 0, a host with a
    // space in it - still walked past the chooser and met its refusal on the
    // next step, where the field is gone, there is no way back and the dialog
    // cannot be dismissed. The rule lives beside requiresEndpoint so the target
    // editor asks the same question of the same field.
    || iperfHostAccepted(endpoint);

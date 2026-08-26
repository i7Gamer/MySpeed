/**
 * Where the welcome wizard is, and whether it may leave.
 *
 * Pure and apart from the dialog, the way welcomeOutcome.js is: this decides
 * whether a first-run setup can be completed at all, and the only way to be
 * sure of that is to hand it a step and a provider and ask.
 */

import {requiresEndpoint} from "../TargetsDialog/providerFields.js";

/** The step the provider cards are on. */
export const PROVIDER_STEP = 2;

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
    // Trimmed, because the server trims before judging: a field holding
    // spaces is a save it refuses, not an address.
    || (endpoint ?? "").trim() !== "";

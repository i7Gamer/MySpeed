import fs from "node:fs";
import {parse} from "yaml";
import {readSource} from "./source.js";

const WORKFLOW_DIR = ".github/workflows";
const PINNED_REF = /^([\w.-]+\/[\w./-]+)@([a-f0-9]{40})$/;

/**
 * The commit each external action is pinned to, one per action.
 *
 * The workflow tests used to copy these SHAs as literals, so every Dependabot
 * action bump failed until someone edited the tests by hand (#106, #107,
 * #109). Reading them from the workflows keeps what the literals guarded:
 * a full-SHA pin, and the same pin wherever an action is used, which a
 * drift between two workflows now fails here by name. Whether a new SHA is
 * the release it claims to be stays a review question, as it always was.
 *
 * Takes [file name, YAML text] pairs; local `./` actions and reusable
 * workflows of this repository are skipped.
 */
export const collectActionPins = (workflows) => {
    const pins = new Map();
    const seenIn = new Map();
    for (const [file, text] of workflows) {
        const jobs = Object.values(parse(text)?.jobs ?? {});
        const refs = jobs.flatMap((job) => [job.uses, ...(job.steps ?? []).map((step) => step.uses)]);
        for (const ref of refs) {
            if (!ref || ref.startsWith("./")) continue;
            const match = PINNED_REF.exec(ref);
            if (!match) throw new Error(`${ref} in ${file} is not pinned to a full commit SHA`);
            const [, action, sha] = match;
            if (pins.has(action) && pins.get(action) !== sha)
                throw new Error(`${action} is pinned to ${pins.get(action)} in ${seenIn.get(action)} but ${sha} in ${file}`);
            pins.set(action, sha);
            seenIn.set(action, file);
        }
    }
    return pins;
};

let repositoryPins;

/** The repository's workflows, read once per test process. */
const readRepositoryPins = () => repositoryPins ??= collectActionPins(
    fs.readdirSync(new URL(`../../${WORKFLOW_DIR}/`, import.meta.url))
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [name, readSource(`${WORKFLOW_DIR}/${name}`)]));

/** `action@sha` as every workflow of this repository pins it. */
export const pinned = (action) => {
    const sha = readRepositoryPins().get(action);
    if (!sha) throw new Error(`No workflow uses ${action}`);
    return `${action}@${sha}`;
};

/** Every external action the workflows use, with its single pin. */
export const repositoryActionPins = () => new Map(readRepositoryPins());

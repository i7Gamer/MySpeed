/*
 * The one vocabulary for where a CPU-floor candidate came from.
 *
 * It lives alone in a leaf because its consumers sit at opposite ends of the dependency graph: the
 * Stage 3 request validator, which imports half the qualification tree, and the guest seed document
 * builder, which imports nothing but node:crypto. Putting the vocabulary in either of them would
 * force the other to depend on it, and the seed builder is deliberately a leaf.
 *
 * `published-release` is a frozen release that some later commit is testing, so the candidate and
 * the harness are different commits. `branch-build` is produced by the commit under test, so they
 * are the same one. Every consumer refuses anything that is neither, rather than treating an
 * unrecognised value as one of them.
 */
export const CANDIDATE_PROVENANCE = Object.freeze({
    published: "published-release",
    branch: "branch-build"
});

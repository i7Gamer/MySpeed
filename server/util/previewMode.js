/**
 * Whether this instance is the public demo.
 *
 * One place to ask, because the comparison was written out wherever it was
 * needed and a guard spelled out by hand is a guard nothing can scan for. That
 * is the failure previewReadOnly was written to end for the mutating routes,
 * and the reads had it too: GET /api/info/version remembered preview mode and
 * GET /api/info/interfaces, two lines below it, did not - and handed every
 * visitor to a demo the operator's network adapters.
 *
 * The exact opt-in string and nothing else. An instance is not a demo because
 * somebody set PREVIEW_MODE=1.
 *
 * Read per call rather than captured at import: a container is configured after
 * the module graph is built.
 */
export const isPreviewInstance = () => process.env.PREVIEW_MODE === "true";

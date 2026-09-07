/**
 * What an API token may do. One scope today: start a test and read the live
 * status of the run it started. Stored on the row as a value rather than
 * implied, so a second scope is a row value rather than a migration.
 *
 * A leaf module with no imports, because the model and the controller both
 * read it and the model must not import the controller.
 */
export const SCOPE_RUN = "run";

export const SCOPES = Object.freeze([SCOPE_RUN]);

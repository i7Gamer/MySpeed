/**
 * Whether a path that fell through to the SPA fallback names a static file.
 *
 * express.static only answers 404 when something behind it does, and behind it
 * sits the catchall - so /assets/missing.js came back as 200 text/html: the
 * index page wearing a script's name. The browser reports that as a MIME
 * refusal three steps removed from the real problem - a stale link after an
 * upgrade, a build that did not finish - and a cache in front is invited to
 * remember the wrong answer for as long as it likes.
 *
 * A dotted final segment is how every build asset is named, and no client
 * route carries one - the router serves "/", "/nodes" and "/statistics", and
 * tests/server/staticAssets.test.js holds the two sides of that bargain
 * together. Kept out of app.js so it can be asked without importing the app
 * and everything the app wires up.
 */
export const isAssetPath = (path) => /\.[a-z0-9]+$/i.test(path);

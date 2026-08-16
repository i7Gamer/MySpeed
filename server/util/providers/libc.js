import fs from 'node:fs';

// Every musl system installs its dynamic loader under one of these names.
// `process.report` would answer the same question, but it is a Node API this
// server cannot count on being present under every runtime it is compiled for.
const muslLoaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/lib/ld-musl-armhf.so.1',
    '/lib/ld-musl-i386.so.1'
];

// Finding one is not the answer on its own. Debian and Ubuntu package musl for
// cross-compiling, and it installs the loader under /usr/lib - which the paths
// above resolve to on every merged-/usr system, so they are present on a
// machine whose own libc is glibc. What actually decides whether the published
// glibc build can exec is whether its interpreter is here, and Alpine has none
// of these.
const glibcLoaders = [
    '/lib64/ld-linux-x86-64.so.2',
    '/lib/ld-linux-x86-64.so.2',
    '/lib/ld-linux-aarch64.so.1',
    '/lib/ld-linux-armhf.so.3',
    '/lib/ld-linux.so.2'
];

/**
 * The one sentence both the refusal to download and the failed run are built
 * from, so the two cannot drift into describing the same system differently.
 */
export const MUSL_CLOUDFLARE_REASON =
    'The Cloudflare CLI is only published for glibc, and this is a musl system';

export const isMuslLinux = (platform = process.platform, exists = fs.existsSync) =>
    platform === 'linux' && muslLoaders.some(exists) && !glibcLoaders.some(exists);

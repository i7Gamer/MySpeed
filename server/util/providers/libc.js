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
// machine whose own libc is glibc. What decides whether the published glibc
// build can exec is whether its interpreter is here.
const glibcLoaders = [
    '/lib64/ld-linux-x86-64.so.2',
    '/lib/ld-linux-x86-64.so.2',
    '/lib/ld-linux-aarch64.so.1',
    '/lib/ld-linux-armhf.so.3',
    '/lib/ld-linux.so.2'
];

// And an interpreter being here is not the answer on its own either, because
// gcompat puts one on Alpine so the odd glibc-only program can run. Alpine
// names its C library twice - the loader above, and this pointing at it - and
// only a musl userspace carries the second name: Debian's musl package ships
// the loader alone, and no compatibility shim adds it. So this settles it
// outright, and the loaders are only consulted when it says nothing.
const muslLibraries = [
    '/lib/libc.musl-x86_64.so.1',
    '/lib/libc.musl-aarch64.so.1',
    '/lib/libc.musl-armhf.so.1',
    '/lib/libc.musl-i386.so.1'
];

/**
 * The one sentence both the refusal to download and the failed run are built
 * from, so the two cannot drift into describing the same system differently.
 */
export const MUSL_CLOUDFLARE_REASON =
    'The Cloudflare CLI is only published for glibc, and this is a musl system';

export const isMuslLinux = (platform = process.platform, exists = fs.existsSync) => {
    if (platform !== 'linux') return false;
    if (muslLibraries.some(exists)) return true;

    return muslLoaders.some(exists) && !glibcLoaders.some(exists);
};

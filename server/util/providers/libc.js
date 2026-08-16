import fs from 'node:fs';

// Every musl system installs its dynamic loader under this name, and no glibc
// system has one - which makes the file the plainest evidence available.
// `process.report` would answer the same question, but it is a Node API this
// server cannot count on being present under every runtime it is compiled for.
const muslLoaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/lib/ld-musl-armhf.so.1',
    '/lib/ld-musl-i386.so.1'
];

export const isMuslLinux = (platform = process.platform, exists = fs.existsSync) =>
    platform === 'linux' && muslLoaders.some(exists);

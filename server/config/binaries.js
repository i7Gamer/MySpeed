/**
 * The speedtest CLIs this build downloads, and the exact bytes it expects.
 *
 * `sha256` is over the *archive* as published, not the binary inside it, because
 * that is what downloadHelper has in hand before it unpacks anything - and
 * unpacking is the first step that writes something the server would later spawn.
 *
 * Pinned here rather than fetched beside the archive. A checksum served by the
 * host that served the file protects against a corrupted transfer and nothing
 * else: whoever can change one can change the other. Pinned, these are a
 * statement about the bytes this version of MySpeed was built against, and they
 * cannot change underneath an instance afterwards.
 *
 * Where they came from, and what that is worth:
 *
 *  - librespeed publishes a checksums.txt with each release, and these are the
 *    values in it.
 *  - cfspeedtest publishes none, but GitHub states a digest per release asset
 *    and these are those.
 *  - Ookla publishes neither, so these were computed from the archives as
 *    served. install.speedtest.net answers 403 to every checksum path tried.
 *
 * None of that attests that the bytes were ever trustworthy - two of the three
 * digests are stated by the same party that serves the file, and the third was
 * taken on trust at the moment it was recorded. What pinning buys is that a
 * later change is caught, which is the threat that matters here: the CLI is
 * downloaded once and then spawned on a schedule for as long as the instance
 * runs.
 *
 * Changing a version means changing its digests. Every entry must carry one -
 * binaryDigest.test.js holds that, because a single entry without one is a
 * platform where the check is silently off.
 */
export const ooklaVersion = "1.2.0";
export const ooklaList = [
    // MacOS. Ookla publishes one universal build, not a per-architecture pair:
    // install.speedtest.net answers 403 for macosx-x86_64.tgz, so the Intel
    // entry that named it had never worked, and arm64 was missing entirely.
    {os: 'darwin', arch: 'x64', suffix: 'macosx-universal.tgz',
        sha256: 'c9f8192149ebc88f8699998cecab1ce144144045907ece6f53cf50877f4de66f'},
    {os: 'darwin', arch: 'arm64', suffix: 'macosx-universal.tgz',
        sha256: 'c9f8192149ebc88f8699998cecab1ce144144045907ece6f53cf50877f4de66f'},

    // Windows
    {os: 'win32', arch: 'x64', suffix: 'win64.zip',
        sha256: '13e3d888b845d301a556419e31f14ab9bff57e3f06089ef2fd3bdc9ba6841efa'},

    // Linux
    {os: 'linux', arch: 'ia32', suffix: 'linux-i386.tgz',
        sha256: '9ff7e18dbae7ee0e03c66108445a2fb6ceea6c86f66482e1392f55881b772fe8'},
    {os: 'linux', arch: 'x64', suffix: 'linux-x86_64.tgz',
        sha256: '5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7'},
    {os: 'linux', arch: 'arm', suffix: 'linux-armhf.tgz',
        sha256: 'e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d'},
    {os: 'linux', arch: 'arm64', suffix: 'linux-aarch64.tgz',
        sha256: '3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3'},

    // FreeBSD
    {os: 'freebsd', arch: 'x64', suffix: 'freebsd12-x86_64.pkg',
        sha256: '88e136dfb3eda918cd93f52af208ab70ea52b7414201ae06976d65e68e2cb25c'}
];

export const libreVersion = "1.0.10";
export const libreList = [
    // MacOS
    {os: 'darwin', arch: 'x64', suffix: 'darwin_amd64.tar.gz',
        sha256: 'b51ae459ec5806b8d4645036a482cabcd5a46f3b922624be1da24521639e8ced'},
    {os: 'darwin', arch: 'arm64', suffix: 'darwin_arm64.tar.gz',
        sha256: '0226d54e78801ac242e49bf0d2044b64de3637ae418995a30cc3acbfa8f960ef'},

    // Windows
    {os: 'win32', arch: 'x64', suffix: 'windows_amd64.zip',
        sha256: 'a0bca0add2a6d08a03838821fb2a6bce9156ae38c98ab1d2c15f1fc7cdf52ee9'},
    {os: 'win32', arch: 'ia32', suffix: 'windows_386.zip',
        sha256: '05b660c7e509904f11c204373da2e37fe1742de72d8db60a4aa1f72fc4d1074c'},
    {os: 'win32', arch: 'arm64', suffix: 'windows_arm64.zip',
        sha256: '70d27c55edcc01ebaaed79fb6c02780c5846797a0025f39a4369fdd96f90e868'},

    // Linux
    {os: 'linux', arch: 'x64', suffix: 'linux_amd64.tar.gz',
        sha256: '8e6d020c17e11dba73f0eb8a11f7ae6e3d96cdb307faf3c0ec13aa54e0cba055'},
    {os: 'linux', arch: 'ia32', suffix: 'linux_386.tar.gz',
        sha256: '0121bd4a21786d5964643b00a4193edfa15389050afe5579a290e67b706ef9eb'},
    {os: 'linux', arch: 'arm', suffix: 'linux_armv7.tar.gz',
        sha256: 'b121733b9a18aa646a16393396dd7fe59e8773420a38acb05b91652c4d6cb356'},
    {os: 'linux', arch: 'arm64', suffix: 'linux_arm64.tar.gz',
        sha256: '0ecbb98abb39f17bde2c0efae23f8446f4596c3a824aa6dda9b71723386b03ed'},

    // FreeBSD
    {os: 'freebsd', arch: 'x64', suffix: 'freebsd_amd64.tar.gz',
        sha256: '6d1073688cc9c12412a4d87099a4635caf3df585d6353cfcefe149bf0dda9d29'},
    {os: 'freebsd', arch: 'ia32', suffix: 'freebsd_386.tar.gz',
        sha256: '782a336703657427f4fe91d1fe8028cb7ac55d9fa5259a375b1e092ae646e6fb'},
    {os: 'freebsd', arch: 'arm', suffix: 'freebsd_armv7.tar.gz',
        sha256: 'b763d6f88536c6c7400b169eb676acec7997d3efd515a67578718309d4a7e55c'},
    {os: 'freebsd', arch: 'arm64', suffix: 'freebsd_arm64.tar.gz',
        sha256: 'febb1a0e59e18324153746928d702338c48d125cfe56e1252e97ffa56989441f'}
];

export const cloudflareVersion = "2.2.2";
export const cloudflareList = [
    // MacOS
    {os: 'darwin', arch: 'x64', suffix: 'cfspeedtest-x86_64-apple-darwin.tar.gz',
        sha256: 'b178863af886ef4bc07053e53360d9ea63cca96bef9962f632a3832f8d7263f6'},
    {os: 'darwin', arch: 'arm64', suffix: 'cfspeedtest-aarch64-apple-darwin.tar.gz',
        sha256: '6c0488a8b5ecfd6285ea616ce082242a10284ee6f1bac761a5a3ae7f6b90f4de'},
    {os: 'darwin', arch: 'universal', suffix: 'cfspeedtest-universal-apple-darwin.tar.gz',
        sha256: '5c4f3541ff661d7ee74db289261ebfaadc86a429edf447817773c481974d5858'},

    // Windows
    {os: 'win32', arch: 'x64', suffix: 'cfspeedtest-x86_64-pc-windows-msvc.zip',
        sha256: '3ff076e3be3ed983e5e5bfde1ad7145f20e0203f0b710e277910a4a7340ee9b6'},

    // Linux
    {os: 'linux', arch: 'x64', suffix: 'cfspeedtest-x86_64-unknown-linux-gnu.tar.gz',
        sha256: '241df2323e5f7dca5b7e3bbed3061800c00081252738dd10d188439501f69b51'},
    {os: 'linux', arch: 'arm64', suffix: 'cfspeedtest-aarch64-unknown-linux-gnu.tar.gz',
        sha256: '0d4778e1ca6856dc1f3303337039a15abee21f09a3ef804ea22bfd09d1b41133'}
];
/**
 * iperf3, which is a different kind of entry from the three above.
 *
 * These are static builds: they carry their own libc, so the one Linux
 * download serves glibc and musl alike - the distinction cfspeedtest needs a
 * refusal for does not arise here.
 *
 * Most of them are also the executable itself rather than an archive
 * containing one, which is what `archive` says. The Windows build is the
 * exception and is the only one that unpacks: it is a Cygwin build, and the
 * zip carries iperf3.exe together with the cygwin1.dll without which it will
 * not start, so both members are extracted under their own names.
 *
 * The digests are the ones GitHub states for each release asset, which is the
 * same footing as cfspeedtest's above; the Windows archive's was additionally
 * recomputed from the asset as served.
 *
 * Refreshed on 2026-09-07, because this publisher rebuilds onto tags that
 * already exist: an OpenSSL change to their Windows build on 2026-09-05 was
 * dispatched on 2026-09-06 and replaced every asset on the 3.21 tag, which
 * has been published since April. Until the pins caught up, every platform
 * refused its own download - which is the guard working, not failing. The 3.20
 * assets were replaced the same way in January, so an older tag is no safer;
 * expect to do this again.
 *
 * Each of the seven below was checked against its GitHub build attestation
 * before it was written here - subject digest, `userdocs/iperf3-static` at
 * master, and that repository's own ci-windows / ci-osx / ci-linux-crossbuild
 * workflow on a GitHub-hosted runner. That is what a refresh has to mean here:
 * a digest copied from whatever the host happens to be serving records the
 * substitution rather than checking it.
 *
 * The macOS builds are per OS version. arm64 takes the macOS 14 build rather
 * than the 15 one on purpose - a binary built against an older SDK runs on the
 * newer system and not the other way about - and Intel is offered only a macOS
 * 15 build, which is the only one published.
 */
export const iperfVersion = "3.21";
export const iperfList = [
    // MacOS
    {os: 'darwin', arch: 'x64', suffix: 'iperf3-amd64-osx-15',
        sha256: '9168916504291356a0779b401052db14c7f4fd93fa657154ea8e60e80cbaf279'},
    {os: 'darwin', arch: 'arm64', suffix: 'iperf3-arm64-osx-14',
        sha256: 'c7c8945847f5228c428b7d1975243c185e4710fbdeb66ce69e87169d76e14d38'},

    // Windows. The one archive, and the one entry carrying a second file.
    {os: 'win32', arch: 'x64', suffix: 'iperf3-amd64-win.zip', archive: true,
        sha256: '913d9aac883f53c2f8c63ab3adcd7c8b00ceceae768e8d03a5a93c75d09c42b4'},

    // Linux
    {os: 'linux', arch: 'x64', suffix: 'iperf3-amd64',
        sha256: '201cbaed73d4e4da72c44c9aee895a2d58c75f1d1a4d721137f4888f6b7f5016'},
    {os: 'linux', arch: 'arm64', suffix: 'iperf3-arm64v8',
        sha256: '2ce83dceb64fe08cea59926647f7ca20a7cb7baa8320e9648823d9b7de562c8e'},
    {os: 'linux', arch: 'arm', suffix: 'iperf3-arm32v7',
        sha256: 'ea23e677bd4a56cfb46f72a4b0aaf1fc9b8ad304d074001554851fa9ad37f608'},
    {os: 'linux', arch: 'ia32', suffix: 'iperf3-i386',
        sha256: '59daa2e73236f445763a34bb9c392ef72f80becd40cfe8a256eca6737a6605d6'}
];

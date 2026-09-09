# Speedtest CLI maintenance

The release maintainer reviews the Cloudflare CLI monthly and before each MySpeed release. Dependabot watches the Docker base images but does not update the `CFSPEEDTEST_VERSION` build argument or downloaded CLI manifests.

| CLI | Deployed version | Last release check | Result |
| --- | --- | --- | --- |
| cfspeedtest | `2.2.2` | 2026-09-09 | The upstream GitHub releases page still lists v2.2.2 as latest; no version change. |

Check [upstream releases](https://github.com/code-inflation/cfspeedtest/releases) and the [published crate](https://crates.io/crates/cfspeedtest) before proposing an update. The dated result above is a GitHub release check; it does not assert that a new container or native CLI was built or run.

For a proposed update:

1. Review release notes and CLI argument/output compatibility with `server/util/providers/registry.js` and `server/util/providers/parseData.js`.
2. Update `Dockerfile`'s `CFSPEEDTEST_VERSION` and `server/config/binaries.js`'s `cloudflareVersion` together. Obtain and verify the SHA-256 digest for every selected release archive; never retain the previous version's digests.
3. Verify that the matching crate builds against musl with the existing Docker toolchain. Run the image verification script and supported native-platform checks, including CLI startup and parser fixtures. A toolchain change requires its own review.
4. Run the full test suite and client build, record the checked version/date here, and review the change before release. `tests/server/muslCloudflare.test.js` guards Docker/native pin parity and `tests/server/cloudflarePin.test.js` checks this document against that pin. These checks perform no network access and cannot establish whether upstream released a newer version.

A newer upstream release is a maintenance proposal, not authorization to update running installations or silently change provider behavior.

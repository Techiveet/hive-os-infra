# Queen Bee CPU inference release

Backend source: `Techiveet/hive-os-backend@e4c04df78cf5a5ad4456bc2d4fb6f01970eba174`.
Base source: `eb98f5a98b0e96e58fed87e0fe2279f38c64668f`, pinned by the registry digest in the Dockerfile.

GitHub Actions run 39031979905 was rejected before any steps ran because of account billing or spending limits. This release builds the exact Git delta on the deployment host using the existing production image. There are no dependency or migration changes in this delta. `git apply --check` rejects a mismatched base. The patch includes the changed runtime files and regression tests; no credentials or environment files are included.

The four PHP services use the same image and build context with `pull_policy: build`, so a subsequent Coolify deployment can reproduce this release without a registry push credential. The SHA tag is presently built locally, not published in GHCR. Keep this build context until a normal CI image has been published and the compose image and pull policy have been updated together.

Validation: 120 SupportBot tests, 434 assertions, followed by the updated staff workflow suite (18 tests, 78 assertions); focused phrasing and credential tests also passed. A production preflight of the native integration returned a grounded English answer in 14.69 seconds with two CPU threads. Amharic generation failed model quality checks and remains guarded by grounded fallback guidance.

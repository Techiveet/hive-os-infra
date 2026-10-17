# Queen Bee production verification — 17 October 2026

The tested central and Aqua Uno flows are deployed: public bot replies using Ollama and retrieved Hive documentation, authenticated staff chat, human handoff, agent replies, saved history, return to AI, answer feedback, and audit filtering. This report records functional checks, not a claim that a small model answers every possible question correctly.

## Release

| Component | Source / image |
| --- | --- |
| Backend, queue, scheduler, Reverb | `Techiveet/hive-os-backend@e4c04df78cf5a5ad4456bc2d4fb6f01970eba174` |
| Frontend | `Techiveet/hive-os-frontend@78e245018ac35c2ec198d481c38dfedbcaecfb7a` |
| Ollama CPU image | `ghcr.io/techiveet/hive-ollama-cpu@sha256:62106c69377c18c84b676725c92984e025de13a1f9fc6c37cbfbe61af8d68b69` |
| Chat model | `qwen3.5:0.8b-q8_0` |
| Retrieval model | `embeddinggemma:300m-qat-q8_0` |

Backend changes were pushed to `codex/tenant-access-lifecycle-20261017`. The infrastructure compose file and reproducible release build context are tracked with this report. The frontend SHA had already been published and deployed.

GitHub Actions run [39031979905](https://github.com/Techiveet/hive-os-backend/actions/runs/39031979905) could not start because of account billing or spending limits. Registry credentials on the deployment host have read access only. No permissions or billing settings were changed. Instead, the deployed backend image is built on the host from an immutable published base plus the exact Git delta; see [the release build context](../ops/releases/queen-bee-e4c04df78/README.md). Its SHA tag is local to that host, not published in GHCR. The compose build context and `pull_policy: build` preserve reproducibility for subsequent Coolify deployments.

The final image ID is `sha256:a3af9adf3ed04c81fdc136b149ac2770ffabde21abcfa1feefc6965579ccba8d`. Runtime file hashes were compared with the pushed checkout:

| File | SHA-256 |
| --- | --- |
| `SupportBotEngineService.php` | `1d3123b50b41ccabd6a476303455ec1303adbb626d7aad868d9f0bc51b1d8532` |
| `SupportBotLlmService.php` | `12bb5496e51d8e5535a4a5b3d268463ebe7bf857e5d340a0366546110cb137cf` |
| `CopilotService.php` | `aa51f4fa3098f4eaa0ac7eb86aa511e2ba4d02cc3a8a03e747826a0f65ec514c` |
| `config/services.php` | `73354b5922b24e8095c6216898050dc525799d2d602a383025b9a999fc305a2a` |

## Fixes and verification

The old OpenAI-compatible Ollama requests used four compute threads inside a two-CPU allocation and repeatedly exhausted the 20-second reply timeout. The native integration now sends two threads, a bounded context and output budget, and disables Qwen thinking for this phrasing task. Irrelevant FAQ hits no longer overwhelm a matched platform guide. Public and staff chat now distinguish a named module question from an explicit request for the whole module directory.

| Check | Observed result |
| --- | --- |
| Public central RAG + actual Ollama generation | Passed; Procurement guide source, model reply, 17.23 seconds |
| Public Aqua Uno RAG + actual Ollama generation | Passed; Procurement guide source, model reply, 18.66 seconds |
| Public history after final PHP rollout | Both workspaces returned persisted messages, HTTP 200 |
| Invalid visitor token / other workspace token | HTTP 401 in both directions |
| Central normal browser sign-in | Passed using the existing administrator account |
| Aqua Uno normal browser sign-in | Passed using the existing tenant administrator account |
| Public human handoff and inbox reply | Passed for central and tenant; visitor history received the browser-sent reply |
| Return public conversation to bot | Passed; transcript retained |
| Signed-in Queen Bee guidance | Both workspaces returned the Procurement guide with `/dashboard/procurement`, rather than the general module list |
| Signed-in central handoff | Request 9 appeared in central inbox; agent reply reached Queen Bee; return to AI retained the transcript |
| Signed-in tenant handoff | Request 10 appeared in the tenant inbox; agent reply reached tenant Queen Bee; return to AI retained the transcript |
| Staff answer feedback | Browser showed “Thanks — noted.” |
| Central audit filters | Today + security category + Aqua Uno returned the tenant sign-in; detail inspection opened correctly |
| Tenant audit filters | Workspace-only view; Today + security category returned its own sign-in; a nonexistent request ID returned zero rows and clearing it restored results |
| Readiness | Backend `/up`, central frontend `/health`, and tenant frontend `/health`: HTTP 200 |
| Runtime | All four PHP services healthy on the final image; all application containers healthy in the final checks |
| Ollama isolation | No published host ports or proxy labels; persistent model volume retained |

Public replies were identified by the LLM response path, not merely an HTTP 200 or a deterministic fallback. Clearly labelled verification conversations were kept for review. Visitor session tokens and credentials remain in private recovery storage and are excluded from Git.

## RAG and learning

The generated platform corpus contains 303 documents; the retrieval build completed with 305 embedded records including two knowledge gaps. Small English and Amharic retrieval calibration sets passed the configured usability gate. Hourly `copilot:index --if-changed` and daily `copilot:learn` are present in the running scheduler.

This is retrieval and feedback-assisted learning. Index updates make new approved information available; feedback and unanswered questions produce reviewable gaps and proposals. It does not retrain model weights automatically or turn every chat message into an approved answer. Private ERP records remain subject to tenant and permission checks.

## Validation and recovery

- Full SupportBot suite after the native Ollama change: **120 tests, 434 assertions passed**.
- Final staff routing/workflow suite: **18 tests, 78 assertions passed**. This includes normal record creation, confirmation, cancellation, validation and audit behavior in the isolated test database.
- Focused native phrasing and provider-credential suite: **28 tests, 80 assertions passed**.
- Pint and whitespace checks passed for the changed files. Compose validation passed after excluding the existing Coolify-only `exclude_from_hc` extension from the validation copy; the actual saved production compose configuration also passed `docker compose config --quiet`.
- The full repository CI still has unrelated baseline formatting/documentation failures; this report does not mark all repository checks green.

An owner-private rollback bundle was created, downloaded with approval, checksum-verified, and rehearsed against an isolated PostgreSQL restore covering all 14 databases. Private compose snapshots exist before each scoped PHP rollout. Database, frontend and Ollama container identities were checked unchanged through the final PHP updates. No passwords were changed by this release process, and no registry or deployment-token privileges were expanded.

## Practical limits and remaining operations work

- The production server has four CPU threads, no GPU and approximately 7.6 GB RAM. Ollama is capped at two CPUs and 1.75 GiB. The observed 17–19 second public model replies are single-request measurements, not a concurrent-load guarantee. Grounded fallback remains available when generation fails.
- The installed small models did **not** pass Amharic generation/coherence checks. Measured language failures now skip model generation and use grounded guidance instead. Amharic retrieval support does not establish fluent Amharic generation.
- GitHub Actions billing must be restored before normal hosted image publishing can resume. Keep the checked-in overlay build context until a replacement CI image is published and the image/pull policy are updated together.
- Root disk was **96% used, about 3.2 GB free** at the final check. Production data, unrelated images and volumes were preserved; capacity work remains.
- A pre-existing scheduled audit archival failure involving `storage/app/audit_archives` is separate from the verified audit search/filter UI. Its command also purges older audit rows; it was not run or enabled as part of this release.

# Queen Bee answer relevance correction

The original check accepted a Procurement navigation guide as an answer to “What is the Procurement module?” The user correctly identified that it answered a different question. A working route and an HTTP 200 were insufficient acceptance criteria.

Backend source: `5b5fcfba1cdfa96b3fe542bd1b6f2dcd5f0f0952` on `codex/tenant-access-lifecycle-20261017`.
Image ID: `sha256:b4eeb8dc5c274a76d24a5cf494c98069cbd43df17d2a8adf8c4a360c4f7f9a39`.
The reproducible [release build](../ops/releases/queen-bee-guidance-final-20261017/README.md) applies the exact Git delta to the immutable published base. Changed runtime file hashes were compared with the pushed checkout before rollout.

## What changed

- Definition questions select the named module's purpose before ranking screen guides. The lookup recognizes “What is the Procurement module?”, “What does procurement do?”, “Explain procurement”, and trailing qualifiers or punctuation. Staff lookup keeps permission, audience and subscription filters; public lookup exposes only public module descriptions.
- Staff and public widgets use the same definition lookup. A short verified purpose is returned directly; the rewriting model cannot turn that definition back into page instructions or add unsupported claims. The destination is a separate optional navigation action.
- Module counts and lists now come from the same catalog used by the central dashboard. The hardcoded count and stale links were removed. Count questions, including “how many modulke do u have”, get a direct count and an explanation that subscription and permissions govern access, without a list of internal operations.
- The catalog assembly was moved unchanged into the existing `ModuleRegistry` and reused by the dashboard and bot, keeping a single source for the count.
- An incorrect positive deployment-test rating on the old navigation answer was changed to “irrelevant” and marked for review. Only that test interaction, its vote and the matching central profile counters were corrected, with a private before-state recovery record.

- Follow-up live testing caught product-creation guidance pointing to Production Lines for an administrator with both module permissions. Guidance now selects the resolved action's permission-filtered destination page before ranking and limits rewriting sources to that module. The regression was demonstrated failing before the fix, then passed with the existing typo and restricted-access cases. No write is staged or executed by guidance.

## Validation

The full definition correction passed **125 tests / 477 assertions**. A subsequent focused set for punctuation, typo count handling and public counts passed **3 tests / 28 assertions**. The final combined bot, dashboard and registry checks and live question/answer evidence are recorded after the production rollout below.

These checks concern the reproduced relevance defects. They do not establish that every question is answerable or that the installed small model is fluent in Amharic. The existing hardware, language-quality and GitHub billing limits remain as described in the original release report.

## Production checks

The initial relevance release passed the full bot, dashboard and registry suite: **133 tests / 564 assertions**, including real disposable tenant database provisioning. Both production public widgets then passed six question/answer comparisons and persisted both histories. Central and Aqua Uno signed-in browser checks confirmed the same Procurement purpose; the central count answer was **55 registered modules**, matching the live dashboard. A navigation question correctly returned `/dashboard/procurement`.

The subsequent product-guidance correction passed **4 tests / 18 assertions**; its final complete SupportBot regression run passed **128 tests / 500 assertions** in 365.78 seconds. Final browser results follow below. The new image's six changed runtime source hashes matched the pushed checkout.

All four PHP services and Ollama were healthy after the initial relevance rollout; backend `/up` and both frontend `/health` endpoints returned 200. Database, frontend and Ollama container IDs were unchanged. A native Ollama generation using the selected `qwen3.5:0.8b-q8_0` model completed with the requested `READY` response in 2.51 seconds. This proves provider availability, separately from the purpose and count answers, which intentionally do not require model rewriting.

Compose syntax was validated with placeholder required values, the existing backend environment file, and Coolify's custom `exclude_from_hc` property omitted only from the validation stream. The actual private production manifest passed `docker compose config --quiet`. GitHub hosted image publishing remains billing-blocked; checked-in build instructions preserve reproducibility without broadening registry credentials.

The final `5b5fcfba1` rollout was verified through both signed-in administrator accounts: repeating **how to create a product** returned **Products (Inventory)**, `/dashboard/inventory/catalog/products`, the catalogue fields and save instructions. The earlier Production Lines answer was marked unhelpful for review rather than accepted. Browser screenshots retain the exact question and corrected answer. Definition and count questions were rechecked on both public workspaces after the final rollout.

Final recovery manifest: `compose-before-guidance-final.yml` in the private production release directory. Only the four PHP images/build context changed; no migrations or dependency changes were required. The final backend image is reproducible through the committed release context. Existing unrelated local files were preserved.

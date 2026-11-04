# Techive website support release

Source revisions:
- Backend: `67c686bb2c6ea6d4a3d6f80fadb02b3d37e2249f`
- Frontend: `b0219a2f1fa39db03795337438b8c7ba0a358b05` (compiled application base: `2c2076769368fab771617aa6198780f30dc3906a`)
- Techive Website: `7f4c85368e3ce680d4a1bedd4a327a444a11fda6`

The backend image applies the exact committed patch to the pinned published base in `backend/Dockerfile`. Build this context with the matching backend tag used in the production compose. All four PHP services use the same image.

The compiled frontend base is built from a clean Git archive of revision `2c2076769368fab771617aa6198780f30dc3906a`, using `Dockerfile.prod` and the existing public production build arguments. Apply `frontend-build.patch` to enable the documented Next.js Webpack memory optimizations and a single build worker before building. On the constrained release builder the build command is `NODE_OPTIONS=--max-old-space-size=2048 RAYON_NUM_THREADS=2 npx next build --webpack`; the independent complete TypeScript check must pass before setting `NEXT_SKIP_BUILD_TYPECHECK=1`. Buildx is limited to 3072 MiB memory, 4096 MiB memory plus swap, and 1.5 CPUs. Preserve the revision label on the resulting image. The image is loaded on the application host; `if_not_present` prevents an unavailable registry artifact from replacing it. Do not prune this image before publishing or retaining a replacement.

The website keeps its normal Coolify Git/Compose deployment and persistent volumes. It loads the dedicated public support widget after hydration, with an accessible bottom-left native launcher and support popover. The popover always offers an ordinary link to open the support chat in a new tab. The SDK launcher is hidden, and the host-controlled closed iframe is inert and excluded from keyboard navigation. SDK readiness enables inline opening when available. Only Hive public support embed routes permit framing from the two approved Techive HTTPS origins. Authenticated Hive routes retain same-origin framing.

The dedicated `techive-website-support` bot has 27 curated, public source-linked articles, website-specific prompts, and human escalation. It returns curated retrieval results directly, without ERP navigation or a model rewriting verified answers. Unknown questions use the configured fallback and can be reviewed in the existing learning inbox; this does not automatically train model weights. Bot configuration and private visitor verification sessions remain outside Git.

Verification covers scoped frontend/backend health, revision and image checks, exact website commit in Coolify, permitted iframe headers, live website answers and staff handoff. Preserve unrelated containers and all existing volumes. Rollback uses the retained previous application images and saved private Compose configuration; no new website data backup was made, as explicitly requested by the owner.

The final `frontend/Dockerfile` adds only the final revision's public `sw.js` to that verified compiled image. Its public embed navigation bypasses the ERP offline sign-in fallback; existing dashboard offline behavior is unchanged. Build the base first, then build this context with the final frontend revision tag. The image revision label records the final Git source revision.

Apply `edge-support-widget.patch` to the authoritative central-host `00-edge.caddy`, validate the complete imported Caddy configuration, and reload gracefully. The exact `/embed/support-bot` path and its children have the existing edge protections with only the approved frame ancestors and no conflicting X-Frame-Options header. Other central routes and other host blocks keep their existing protections. The live edge is external to the application Compose; changing Next.js headers alone is insufficient.

The focused keyboard regression check runs the actual emitted SDK template in a Node VM and checks hidden, open, closed-again and legacy states:

```sh
node ops/releases/techive-website-support-20261017/verify-loader.cjs /path/to/hive-os-backend/Modules/SupportBot/app/Http/Controllers/SupportBotEmbedController.php
```

The automated browser held a cross-origin iframe document response paused despite a 200 response and the approved framing headers. Inline visual interaction therefore remains unverified by that browser tool. The ordinary website-to-new-tab support flow was exercised with real visitor questions and a signed-in staff inbox. Do not bypass browser response controls or relax other framing protections. Temporary narrowly scoped chat diagnostics were removed after verification.

Final production verification on 2026-10-17 UTC:
- Backend, queue, scheduler and Reverb healthy at `67c686b`; `/health` returned `status: ok`; 60 unrelated root-host containers retained their IDs.
- All seven Techive website services healthy after the exact `7f4c853` Coolify release; existing API storage, Next, MySQL, Redis and Meilisearch volumes retained; 35 unrelated EV containers retained their IDs.
- Real website launcher opened the public support chat. Pricing matched the published proposal policy; an unrelated washing-machine question used the honest fallback. The labelled visitor reached the normal staff inbox and received an administrator test reply. Returning to the assistant produced the published 4-8 week website timeline. Reloading and reopening the chat restored the questions, answers and staff reply from persisted history.
- Live native launcher Enter/Space, Escape focus return and hidden-frame Tab exclusion checked. The SDK VM regression passed. Website lint, Next type generation and TypeScript checks passed; accessibility contrast script reported 12/12 checks, zero failures.
- GitHub-hosted website CI could not start because of account billing limits; the guarded normal Coolify deployment finished at the exact source SHA instead. Frontend `/version.json` is absent; frontend revision proof uses image labels and source/image checks rather than that endpoint.

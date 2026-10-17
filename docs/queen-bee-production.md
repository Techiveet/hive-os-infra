# Queen Bee on the production VPS

The CPU-only Ollama image is built in the backend repository from official Ollama 0.34.3. The final image excludes GPU runtimes. The compose defaults pin OLLAMA_IMAGE to the tested registry digest and HIVE_BACKEND_TAG / HIVE_FRONTEND_TAG to the release commit SHAs. Update these defaults for each coordinated release.

Ollama has no published port. It shares the private Hive network and persists models in hive-ollama-models. Its limits are two CPU threads, 1792 MiB memory, 2048 MiB memory plus swap, one resident model, one parallel generation, and a 2048-token context. The VPS has no GPU. Measure latency before changing models; larger models can exhaust resources needed by the ERP.

The checked-in defaults pin the tested release, so rollout does not require changing Coolify token permissions. Coolify runtime overrides remain supported. Required effective runtime settings:
- OLLAMA_BASE_URL=http://ollama:11434/v1
- OLLAMA_MODEL=qwen3.5:0.8b-q8_0
- OLLAMA_EMBEDDING_MODEL=embeddinggemma:300m-qat-q8_0
- COPILOT_PROVIDER=ollama
- COPILOT_MODEL=qwen3.5:0.8b-q8_0

Pull both models into the named volume before accepting traffic. Existing workspace bot settings are preserved by the application, so administrators must explicitly move bots with missing cloud credentials to Ollama. Do not overwrite working customer provider credentials.

After deployment, run copilot:index and copilot:embed. Embedding builds also calibrate English and Amharic retrieval. Verify staff chat, cited answers, human handoff, agent reply, refresh recovery, return to AI, public widget isolation, and tenant isolation through normal application authentication.

Learning indexes changed documentation and proposes answers from conversations and feedback. Proposed answers require approval before reuse; it does not train model weights.

Before rollout, save the database cluster, current compose, private environment, Coolify application/environment metadata, and image identifiers in an owner-private recovery directory. Verify checksums and rehearse the database restore in isolation. Roll back by restoring the saved compose and runtime settings and selecting the prior images; preserve database and model volumes. Do not restore database contents over live writes without a separate recovery decision.

The measured CPU choice is Qwen 3.5 0.8B Q8 with thinking disabled for rewriting. It preserved the supplied facts in the benchmark; Amharic generation failed the language/coherence checks. Measured unsupported languages skip generation and retain grounded guidance plus human handoff. Semantic retrieval is separate: the English and Amharic Q8 embedding calibrations were usable (100% / 80% recall in the small calibration set). These checks do not establish perfect answers or unrestricted multilingual fluency.

Reply and phrasing budgets are 128 output tokens, with a 20-second phrasing timeout. The final PHP-only correction can be applied with Docker Compose up --no-deps for backend, queue, scheduler and reverb using a private, validated manifest derived from the live Coolify configuration. Preserve its names, labels, networks, environment and mounts; change only the four application images and the documented assistant settings. Keep the prior manifest for rollback. Later full Coolify deployments use the same Git defaults.

# Queen Bee on the production VPS

The CPU-only Ollama image is built in the backend repository from official Ollama 0.34.3. The final image excludes GPU runtimes. The compose defaults pin OLLAMA_IMAGE to the tested registry digest and HIVE_BACKEND_TAG / HIVE_FRONTEND_TAG to the release commit SHAs. Update these defaults for each coordinated release.

Ollama has no published port. It shares the private Hive network and persists models in hive-ollama-models. Its limits are two CPU threads, 1792 MiB memory, 2048 MiB memory plus swap, one resident model, one parallel generation, and a 2048-token context. The VPS has no GPU. Measure latency before changing models; larger models can exhaust resources needed by the ERP.

The checked-in defaults pin the tested release, so rollout does not require changing Coolify token permissions. Coolify runtime overrides remain supported. Required effective runtime settings:
- OLLAMA_BASE_URL=http://ollama:11434/v1
- OLLAMA_MODEL=qwen2.5:1.5b
- OLLAMA_EMBEDDING_MODEL=embeddinggemma:300m-qat-q8_0
- COPILOT_PROVIDER=ollama
- COPILOT_MODEL=qwen2.5:1.5b

Pull both models into the named volume before accepting traffic. Existing workspace bot settings are preserved by the application, so administrators must explicitly move bots with missing cloud credentials to Ollama. Do not overwrite working customer provider credentials.

After deployment, run copilot:index and copilot:embed. Embedding builds also calibrate English and Amharic retrieval. Verify staff chat, cited answers, human handoff, agent reply, refresh recovery, return to AI, public widget isolation, and tenant isolation through normal application authentication.

Learning indexes changed documentation and proposes answers from conversations and feedback. Proposed answers require approval before reuse; it does not train model weights.

Before rollout, save the database cluster, current compose, private environment, Coolify application/environment metadata, and image identifiers in an owner-private recovery directory. Verify checksums and rehearse the database restore in isolation. Roll back by restoring the saved compose and runtime settings and selecting the prior images; preserve database and model volumes. Do not restore database contents over live writes without a separate recovery decision.

---
trigger: glob
globs: "src/ai/**, src/prompts/**"
---
<!-- GENERATED from agent-system/rules/ai-pipeline.md by `npm run gen:configs`. Edit the source, not this file. -->

# AI pipeline — prompt registry, model invocation, validation

Authority: AGENTS.md §4 rules (Prompts & AI).

| Don't | Do instead | Enforced |
|---|---|---|
| Construct ad-hoc prompt strings inline in business logic | Prompts live exclusively in a versioned registry with SemVer identifiers | `prompt-registry` |
| Interpolate unescaped user text directly into prompts | Sanitize and delimit untrusted text before prompt construction | `prompt-delimiters` |
| Trust raw LLM text output as structured data | Validate and parse all LLM output strictly through schemas (e.g. Zod) | `ai-output-zod` |
| Make unmonitored model calls without fallbacks | Route all model invocations through a resilient repository with safety fallback chains | `ai-resilience` |

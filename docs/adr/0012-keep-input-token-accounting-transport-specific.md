# Keep input-token accounting transport-specific

ACP and headless Grok output expose different token semantics, so the provider does not force them into one inferred interpretation. ACP keeps Grok's reported input total and cache-read value unchanged, leaving no-cache and cache-write undefined.

Headless accounting distinguishes payload families by their field vocabulary. Grok/Anthropic-style cache fields treat `input_tokens` as non-cached input and compute total input from input, cache-read, and cache-write components; OpenAI-style `cached_tokens` or `prompt_tokens` records treat `input_tokens`/`prompt_tokens` as the already-inclusive total and derive no-cache input by subtracting cache read only when the values are valid. This preserves both upstream contracts without double-counting cached tokens or changing the established ACP behavior.

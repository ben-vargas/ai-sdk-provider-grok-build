# Keep the transport core independent of AI SDK generation

The current release line targets AI SDK v7, while transport, pooling, normalization, redaction, and usage accounting remain independent of V4 provider types. AI SDK generation differences are confined to thin adapter layers so the AI SDK v6 maintenance line can reuse the same behavioral core through a V3 adapter instead of carrying a separate transport implementation.

The transport core also owns ACP response validation and observational callback isolation. Adapters consume already validated protocol state and may deliberately surface their own normalization or emission errors for the owning generation without changing the transport contract for consumer callbacks.

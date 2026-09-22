# Validate ACP state at the client boundary

Consumed `initialize`, `session/new`, `session/load`, and `session/set_config_option` results are validated at the `AcpClient` response boundary before typed state is returned or cached. Malformed payload diagnostics retain credential redaction. A malformed initialization makes that client unusable so a pool replaces it on the next acquisition, while malformed session responses reject only their request and leave an otherwise healthy client available.

Optional `null` model and configuration state is normalized to absence. Known select and boolean configuration kinds are validated strictly, including required identifiers, names, current values, groups, and nested choices. Unknown future kinds are preserved after their common envelope is validated. Public types accept boolean set requests and both flat and grouped select choices, but the provider does not advertise a boolean-option capability until it implements negotiation for one.

Provider model and reasoning selection consumes only select options. Grouped choices are flattened at that selection boundary, while boolean and unknown kinds are retained for low-level callers and ignored by provider selection. Model metadata is validated through the current reasoning effort, the available effort collection, and every consumed effort choice before it becomes typed state.

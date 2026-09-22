# Apply model and reasoning selection at the session boundary

ACP model and reasoning effort are session configuration, so the provider applies them after `session/new` or `session/load` and validates requested values against the choices advertised by Grok. Selection precedence is call-level provider options, AI SDK reasoning, model or provider defaults, then the Grok default; unavailable or rejected values produce an explicit warning or error instead of a silent substitution. Headless reasoning overrides are also derived from a fresh settings copy for every call, so a request-specific effort never becomes a later request's model default.

Only select configuration options participate in provider model and reasoning selection. Flat and grouped choices are supported, with groups flattened only while resolving those selectors; boolean and unknown option kinds remain available to low-level callers without being interpreted as model controls.

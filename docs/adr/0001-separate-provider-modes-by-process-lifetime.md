# Separate provider modes by process lifetime

The package exposes three additive modes with distinct ownership contracts: `grokBuild` owns one ACP child per generation, `grokAgent` opts into provider-owned persistent ACP clients, and `grokExec` owns one headless child per generation. This preserves existing cleanup behavior while letting consumers choose between startup overhead, persistent resource ownership, and native headless capabilities; every mode continues to use the stable `"grok-build"` provider-options and metadata key.

# Grok binary resolution and security

The provider launches a local executable with the configured working directory, environment, and credentials. Treat binary selection as part of your application security boundary.

## Resolution order

The resolver checks these sources in order:

1. `executablePath`, when supplied.
2. The `@xai-official/grok` package resolved from `cwd`, only with `allowPackageBin: true` and only on non-Windows platforms.
3. A native `grok` executable on `PATH`.
4. `npx -y @xai-official/grok@^1`, only with `allowNpx: true` and only on non-Windows platforms.

The first matching source wins. Every resolved command receives `--no-auto-update`, and the provider performs a cached, independent 30-second version check by default. `timeouts.requestMs` applies only to ACP JSON-RPC requests; direct low-level callers can override the version bound with `GrokVersionCheckOptions.timeoutMs`. A caller abort stops only that caller's wait; it does not terminate or invalidate a version check shared with another call.

## Recommended configurations

For production and CI, prefer an absolute `executablePath` managed by the deployment image:

```ts
const model = grokExec("grok-4.6", {
  executablePath: "/opt/grok/bin/grok",
});
```

Using `PATH` is appropriate when the process environment is controlled and its directories are not writable by untrusted users or repositories.

Package discovery is disabled by default. Enable it only when `cwd` and its dependency tree are trusted:

```ts
const model = grokExec("grok-4.6", {
  cwd: trustedCheckout,
  allowPackageBin: true,
});
```

With that option enabled, a repository-controlled `node_modules/@xai-official/grok` package can execute during the version check and model call. It inherits the provider environment, which may include `XAI_API_KEY`. Do not enable it for pull-request checkouts, downloaded archives, user-selected directories, or other untrusted workspaces.

`allowNpx` is also explicit because it can download and execute a package. Pin and provision the CLI outside the application when reproducibility or supply-chain control matters.

## Windows

Windows requires a native Grok executable through `PATH` or `executablePath`. PATH lookup skips `.cmd` and `.bat` shims and continues searching for a native executable; an explicit script path is rejected with `GROK_CLI_WINDOWS_SCRIPT_UNSUPPORTED`. The provider does not use package-bin discovery or the `npx` fallback on Windows. Point `executablePath` at the native executable itself, not at a command-script shim.

## Permissions and environment

Binary trust is separate from tool permission policy. Every ordinary invocation supplies `--permission-mode`: headless `grokExec` defaults to `dontAsk`, while ACP defaults to `default` because it has a permission-response channel. Dangerous bypass supersedes the ordinary permission-mode and approval flags. The selected Grok process still receives the configured `cwd` and environment and may execute provider-owned tools. Limit secrets in `env`, scope `cwd`, configure sandbox and tool rules, and avoid `alwaysApprove` or `dangerouslySkipPermissions` outside an isolated environment.

Version failures are typed so applications can distinguish missing binaries, unsupported Windows launchers, timeouts, unsupported versions, and unrecognized output. Prompt failures after dispatch are non-retryable because the process may already have changed external state.

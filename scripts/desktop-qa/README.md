# Windows desktop QA

From the checkout or a nested worktree, run the baseline with Node.js 24 and an existing production build. Pass the actual source commit for the build.

```powershell
node scripts/desktop-qa.mjs . <source-commit>
```

By default the runner uses the Obsidian installation under the current Windows user profile. Set `KB_QA_OBSIDIAN` to the executable path when the installer is elsewhere. Append `0`, `10`, `100` or a comma-separated combination to run a subset.

The runner writes each fresh synthetic Vault, Obsidian profile, temporary files, process receipts, phase-level I/O counts and diagnostic log into `.tmp/plugin-improvement-qa` in the common checkout. It accepts the first-run plugin trust prompt inside that Vault, restarts, verifies the Vault path over loopback and times the trusted startup. Obsidian updates are disabled in the test profile and the Chromium network flags direct external traffic to a closed loopback port. Each process receipt gives the launched PID and exit status.

The instrumented plugin copy counts Node filesystem API calls under the fixture root and Obsidian's adapter reads of the plugin registry file. Bytes are the data returned by the observed read calls. Separate calls to detect EOF can return zero bytes. These measurements describe application-level I/O and include browser paint readiness only where the wait checks the panel or report DOM. The desktop host can perform its own startup indexing outside these counters.

Fixtures contain two Markdown notes per registration and no Git objects. The test opens the manager through its registered command, then uses the panel refresh, library action menu, custom check selector and start button. An empty registry has no library from which to run a check. A selected manifest report must contain exactly one passing check in its on-disk log.

Run the end-to-end workflows from the repository root with the existing local Templater 2.11.1 fixture in `references/templates/obsidian-amatzk-template`.

```powershell
node scripts/desktop-qa/workflows.mjs . <source-commit> all
```

The workflow creates two libraries in an isolated Vault, changes shared settings and Git state, and checks cancellation, diagnostic history, Templater expansion, template update conflicts, selected references during a move, and manager layout. Each run saves its observations and the host version in `workflows.json` alongside the process receipts. The external Git scenario sends a focus event to the native app renderer after staging and committing through Git.

Run the native Bases regression with a production build.

```powershell
node scripts/desktop-qa/bases.mjs . <source-commit>
```

The runner creates a Kepano library and an LLM Wiki in a separate synthetic Vault and moves both through the manager. It checks the 20 newest episodes in **Last seen**, the excluded records and all four Wiki overview views before and after the move. It also opens the Wiki overview as an embed from within the library and from a different folder to check the host filter. The run writes the expected and actual file paths, native result counts and move receipts to `bases.json` under its `.tmp/plugin-improvement-qa/bases-move-*` directory.

To run a separate desktop scenario, import `workspaceScratch`, `prepareRun`, `launchDesktop` and `trustFixture` from `scripts/desktop-qa-host.mjs`. Seed the fixture under the returned `vault`, then launch and trust it before calling `desktop.evaluate` or `desktop.call`. Supply the local Templater plugin directory in `prepareRun` to enable it alongside the manager. Call `desktop.close()` in a `finally` block to close the owned instance and record its exit.

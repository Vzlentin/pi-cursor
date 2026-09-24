# Local native-tool rollback (2026-09-24)

This checkout is based on upstream `v1.4.38` (`b8c11bc`), on branch
`local/restore-native-tools`, published as `main` on
`https://github.com/Vzlentin/pi-cursor`. Pi installs it from GitHub instead of
the npm package.

## Changes

- Reverted PR #36 (merge `bbf73369f6013e5d033d189ef9268427b23c30d6`, parent 1),
  restoring provider-native reads, listings, searches, writes, deletes and shell
  execution and removing the native-tool prohibition prompt and retry counter.
- Kept the upstream release changelog as historical documentation.
- Preserved Pi 0.86+ transcript compatibility, model routing, current protobuf
  definitions, transport fixes and the new grind/VM handlers from 1.4.38.
- Added an explicit `ExecClientControlMessage.streamClose` after native streaming
  shell completion. The old code sent a shell exit event but never closed the exec
  RPC: live Opus 5.5 executed commands and then waited indefinitely. Cursor's
  installed CLI also sends the close control message after the final result.
- Added `tests/native-stream-close.test.ts` for successful and nonzero shell exits,
  result ordering, matching request IDs, and the final close control message.

## Native tools run as Pi tool calls (2026-09-24, later)

Cursor-native reads, writes, deletes, listings, searches and shell commands are
no longer executed inside the provider. Each exec becomes a Pi tool call
(`read`, `edit`/`write`, `bash`, `ls`), so it runs through Pi, shows in the TUI
and is saved in the session transcript; the Pi result is encoded back into the
native protobuf result Cursor waits for (`src/stream/native-pi-tools.ts`).

- Model reads use Pi `read` with the model's offset/limit; Cursor still receives
  the whole file because its server does the slicing.
- Cursor implements edits as read + full-content write. The read is answered
  directly (it is only the edit's base); the write becomes a Pi `edit` hunk
  computed against that base, or a Pi `write` for new files and rewrites.
- Grep runs `rg` through Pi `bash`; delete runs `rm`; ls uses Pi `ls` or `ls -1Ap`.
- Fetch and diagnostics still run in the provider.
- `PI_CURSOR_NATIVE_TOOLS=native` restores in-provider execution.
- Unit tests: `tests/native-pi-tools.test.ts`. Not yet verified live.

## Validation

- `corepack yarn check`: passed (40 test files, 326 tests, plus typechecking,
  lint, formatting, security/protobuf checks and five legacy test scripts).
- `corepack yarn build`: passed.
- Live `cursor/claude-opus-5-5`, medium reasoning, Pi 0.87.1:
  - Inspected a disposable project, read a random nonce not supplied in the
    prompt, ran tests, and correctly reported the deliberate subtraction bug.
  - Resumed that session, fixed the source, created an exact-content marker and
    ran the tests successfully. Files and test results were independently checked.
  - After enabling the package, repeated verification with normal user extensions
    and skills enabled (10 Pi tools advertised). Reads and shell completed, and
    both fixture tests passed. No special tool-routing prompt was needed.
- The unmodified rollback initially stalled on shell operations; do not remove
  the stream-close fix when rebuilding.

## Known limitations

With `PI_CURSOR_NATIVE_TOOLS=native`, native calls bypass Pi tool hooks, tool
allowlists, and normal tool-call display/history. In the default mode, the reads
Cursor makes as an edit's base and the full-file content returned for model
reads come from disk, not from Pi's tool output. Background shell/stdin support
is still limited.

This does not fix upstream MCP tool discovery. Unknown, non-stranding wire fields
were logged during successful tests. Short smoke tests do not establish long-run
stability, compaction behavior, or full Cursor protocol compatibility.

## Build and activation

Pi installs this fork from GitHub. In `~/.pi/agent/settings.json`:

```json
"https://github.com/Vzlentin/pi-cursor"
```

`dist/` is gitignored; the package's `prepare` script runs `tsup` when Pi
installs dependencies in its managed checkout. `.npmrc` sets `legacy-peer-deps`
because npm 10 crashes (`reading 'edgesOut'`) resolving the dev peer set of a git
install. `pi update --extensions` pulls
new commits from the fork's `main`. It does not receive npm updates.

To develop, from a clone of the fork:

```sh
corepack yarn install --immutable
corepack yarn check
corepack yarn build
```

Push to the fork's `main`, then run `pi update --extensions` and restart Pi.
Prefer a fresh chat so old refusal messages do not remain in the model's context.

## Undo

In `~/.pi/agent/settings.json`, replace only this package entry:

```json
"https://github.com/Vzlentin/pi-cursor"
```

with:

```json
"npm:@rahularya01/pi-cursor@1.4.38"
```

Then run `pi update --extensions` and restart Pi.

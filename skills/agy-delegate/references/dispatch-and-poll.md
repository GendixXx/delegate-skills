# Dispatch and poll

`scripts/relay.mjs` is the dispatch layer. It wraps `agy --print`, runs the brief in Antigravity,
captures the final response, and writes a structured `result.json`. Your job collapses to: run one
command, then read one file.

## Before the first run: check the binary

```bash
command -v agy
agy help
agy models
```

`agy models` proves the CLI can authenticate and list available model labels. The relay records the
version it can infer from `agy changelog` into `result.json`. Neither command proves that a headless
write will be approved.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

(`<skill-dir>` is wherever this skill is installed - the folder containing its `SKILL.md`.)

Options:

| Flag | Effect |
| --- | --- |
| `--brief <file>` | The brief. Omit it to read the brief from stdin before passing it to `agy --print`. |
| `--cd <dir>` | Working root for Antigravity (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Antigravity model label. Optional; a fresh run can use Antigravity's configured default. |
| `--effort <level>` | Reasoning effort: `low`, `medium`, or `high` (passed as agy's own `--effort`). |
| `--project <id>` | Use an existing Antigravity project. |
| `--new-project` | Force a fresh Antigravity project. This is the default for fresh dispatches. |
| `--resume-last` | Continue the most recent Antigravity conversation; send only the delta brief. |
| `--conversation <id>` | Continue a specific Antigravity conversation; send only the delta brief. |
| `--sandbox` | Enable Antigravity's terminal sandbox for the run. |
| `--read-only` | Run in plan mode (`--mode plan`), removing write and edit paths; mutually exclusive with `--dangerously-skip-permissions`. |
| `--dangerously-skip-permissions` | Pass Antigravity's permission-bypass flag; mutually exclusive with `--read-only`. Never use this unless the human explicitly accepts it. |
| `--print-timeout <duration>` | Timeout agy itself applies to print mode (default: `30m`). |
| `--timeout <dur>` | Relay-side watchdog (e.g. `30m`); overrides the default of `--print-timeout` plus a 60s grace. On expiry the agy process tree is killed and `result.json` gets `status: "timeout"`. Set it explicitly when agy may hang past its own print timeout. Malformed, zero, and out-of-range durations are rejected; the maximum is `596h31m23s`. |
| `--add-dir <dir>` | Add an extra workspace directory. Repeatable; relative paths resolve against `--cd`. Fresh runs always add the `--cd` repo (absolute path) as a workspace dir. Edits inside extra workspaces are not reported in `touchedFiles`. |
| `--out-dir <dir>` | Where artifacts go (default: a fresh dir under the system temp dir). |

Artifacts default to the system temp dir on purpose: the repo under review stays clean, so the
touched-files report shows only Antigravity's edits and nothing of the helper's own.

## The result

`<out-dir>/result.json` is the contract. Fields:

- `schema` - the result-format version (currently `delegate-relay.result.v1`)
- `tool` - `agy`
- `status` - `completed` | `failed` | `timeout` | `aborted` | `agy_unavailable`
- `exitCode` - mirrors Antigravity's exit code; `128` plus the signal number if the child was killed; `127` if `agy` is not on PATH; on a `timeout` the relay forces a non-zero code even when the child exited `0` after the watchdog's SIGTERM
- `signal` - the signal that killed the child, otherwise `null`
- `agyVersion` - inferred from `agy changelog` when available
- `agyStatus` - Antigravity's own run status from the payload (e.g. `SUCCESS`); `null` without a payload.
  It is recorded, not acted on - the relay's own `status` is the field to branch on
- `projectId` - parsed from the Antigravity log when present
- `conversationId` - the payload's `conversation_id`, falling back to the Antigravity log
- `finalMessage` - the payload's `response`; the whole of stdout when there is no payload
- `usage` - the payload's token counts (`input_tokens`, `output_tokens`, `total_tokens`, …); `null` without a payload
- `numTurns` - the payload's `num_turns`; `null` without a payload
- `deniedActions` - the permissions headless mode auto-denied, by name (e.g. `["command"]`), from the
  payload's `denied_actions` or, failing that, Antigravity's stderr denial sentinel. `null` when nothing
  was denied. **A denial does not by itself fail the run:** if Antigravity still reported or still edited,
  `status` is `completed` and this field is how you learn the run may be partial. It fails only when the
  denial left nothing behind
- `touchedFiles` - `git status --porcelain` lines in the working root: your review starting point.
  `null` (not `[]`) when git cannot report; `[]` means git ran and the tree is clean
- `readOnlyViolation` - `true` when fingerprints prove a working-tree change, `false` when coverage is complete and proves none, and `null` when fingerprinting was incomplete or the run was not `--read-only`
- `briefPath` / `finalPath` / `logPath` / `stderrPath` - the exact brief, final message, Antigravity
  log, and stderr capture
- `workdir`, `model`, `effort`, `project` (the `--project` you passed, vs `projectId` parsed from the log),
  `sandbox`, `readOnly`, `dangerouslySkipPermissions`, `resumed` (true for a `--resume-last` or `--conversation`
  run), `startedAt`, `finishedAt`
- `stderrTail` - last ~20 stderr lines; present on every run that did not complete (`failed`, `timeout`, `aborted`), except a launch failure, which reports `failed` with no `stderrTail`; also present when `finalMessage` is empty so diagnostics are not discarded
- `error` - present on a launch failure, `timeout`, `aborted`, headless permission denial, or silent no-op

The helper also prints a summary to stdout and normally exits with Antigravity's exit code. It forces
exit 1 when Antigravity exits 0 after a headless permission denial that produced nothing, or with neither
a final message nor observable working-tree changes, so a wrapping script can branch on success/failure
directly.

## Why the run asks for JSON

The relay dispatches with `--output-format json`, so Antigravity returns one structured object rather than
prose. Three things come from it that text mode could not give: `conversation_id` without scraping the log,
token `usage`, and `denied_actions` - the permissions headless mode auto-denied, as a field instead of a
sentence the CLI is free to reword. A build that prints prose anyway still works: the relay treats stdout
as the report and falls back to matching the stderr denial sentinel.

## Waiting for completion

The helper blocks until Antigravity finishes. Back it with whatever your orchestrator offers:

- **Claude Code:** run the Bash call with `run_in_background: true`; you're notified on completion,
  then read `result.json`.
- **Plain shell / other agents:** foreground for short tasks, or background and poll. A run is done
  when `result.json` exists with a `status`. A pre-run usage error exits with code 2 before writing any
  file, so check the exit code too. A missing `agy` binary exits 127 and writes `result.json` with
  `status: agy_unavailable`.

Trust the working tree and the process state over any progress display. A run is finished when the
process has exited and `result.json` is written.

## When a run misbehaves

- **`status: agy_unavailable` (exit 127):** `agy` is not on PATH. Install the Antigravity CLI and run
  its first-launch setup, then re-dispatch.
- **`status: timeout`:** the relay watchdog killed the run. Inspect `error` to see whether the selected
  limit was explicit `--timeout` or the derived `--print-timeout` plus 60s grace. The working tree may
  hold a half-applied change — inspect it before changing that limit, reducing the brief, or resuming.
- **`status: aborted`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to agy. The result is written before the relay exits;
  inspect the working tree before re-dispatching. On native Windows a hard kill of the relay is
  uncatchable (Node supports no `SIGTERM` handler there), so this status may never get written -
  a relay process that is gone without a `result.json` is an aborted run; inspect the working
  tree and the run's `agy.log` and `stderr.txt` directly.
- **`status: failed` with `signal: "SIGKILL"`:** the host ended the child - commonly the OOM killer
  or a supervisor timeout, not an implementer error. Free up host memory or split the task into
  smaller briefs, then re-dispatch.
- **`status: failed`:** read `result.json`'s `stderrTail`, `stderrPath`, and `logPath` for the cause.
  Common causes: auth lapse, an unknown model label, timeout, or a permission the run needed.
- **Headless permission denied:** `deniedActions` names what Antigravity auto-denied. If the denial left
  the run with nothing - no report, no edits - the relay reports `status: failed`, preserves `stderrTail`,
  and exits 1. If the run worked around it, `status` stays `completed` and the denial rides in
  `deniedActions` with a warning in the summary; read the report and the diff, because the run may be
  partial. Either way the fix is an allow-rule, not the bypass flag - see
  [Allow-rules before the bypass flag](#allow-rules-before-the-bypass-flag), and on Windows
  [Windows permission engine traps](#windows-permission-engine-traps), before re-dispatching or asking
  to use `--dangerously-skip-permissions`.
- **Empty `finalMessage`:** a run with edits may still be correct - check `touchedFiles`, the diff, and
  the preserved `stderrTail`. With no observable edits, the relay reports `status: failed` rather than
  claiming completion. To get a report next time, add a `<structured_output_contract>` block (see
  [writing-the-brief.md](writing-the-brief.md)).

## Allow-rules before the bypass flag

Headless `--print` cannot prompt, so Antigravity auto-denies any permission it would otherwise ask about.
On a default install that can stop a dispatch before it reads a single file. There are two ways out, and
they are not equivalent:

1. **A narrow allow-rule** in Antigravity's CLI settings - `permissions.allow` in
   `~/.gemini/antigravity-cli/settings.json` (the CLI creates neither the file nor the directory entry for
   you; `agy` names the path it tried to read in its own log). Each rule is `<action>(<target>)`, and
   `deniedActions` in `result.json` gives you the action name to write:

   ```json
   {
     "permissions": {
       "allow": ["read_file(*)"]
     }
   }
   ```

   Allow-rules apply in `--print` mode: on agy 1.2.x a dispatch auto-denied `read_file` ran normally once
   a `read_file(*)` rule was added, and a `write_file` rule naming the workspace allows a headless write.
   `command(...)` matches the full command string, and on Windows the traps
   [below](#windows-permission-engine-traps) apply to both `command` and `write_file` rules.

2. **`--dangerously-skip-permissions`**, which auto-approves *every* tool permission request, including
   requests to act outside the sandbox. It is not a scoped grant and the whole run must be treated as full
   access.

Prefer (1). Reach for (2) only with the human's explicit agreement. Either way this is a change to the
human's machine-wide Antigravity config: propose the exact rule, say what it grants, and let them apply
it rather than editing their settings yourself.

## What the helper is doing

Under the hood the helper runs roughly:

```bash
agy --new-project --add-dir <repo> --print-timeout 30m --print=<brief>
agy --continue --print-timeout 30m --print=<delta brief>
agy --conversation <id> --print-timeout 30m --print=<delta brief>
```

`agy --print` requires the prompt as a flag argument, so keep briefs focused. The relay still accepts
stdin or `--brief <file>` for your convenience; it reads the text first, then passes it to `agy` as
`--print=<brief>` (the `=` form so a brief that begins with a bare flag like `--help` still runs).
Two consequences of the brief riding the command line: it is visible in the host process list (`ps`),
so on a shared machine keep secrets out of it; and a brief over ~120 KB is rejected up front (the OS
caps a single argument), so have `agy` read large context from the workspace instead of inlining it.

## The commit boundary

The helper never commits - by design, not omission. The robust contract is: Antigravity edits the
working tree, the orchestrator reviews and commits. See [review-and-land.md](review-and-land.md).

## Windows permission engine traps

When a headless `--print` run needs a permission `agy` cannot prompt for, it is auto-denied. `agy`'s
error message advises adding an allow-rule under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`,
e.g. `command(<target>)`. Allow-rules do apply in `--print` mode (a `write_file` rule naming the workspace is
what let a headless write run succeed here), but on Windows that instruction frequently cannot work due to an
open upstream defect in Antigravity's permission engine ([issue #614](https://github.com/google-antigravity/antigravity-cli/issues/614)).

### Executable path splitting

The permission engine splits a resolved executable path on whitespace before matching, so a binary living under a path
containing a space is evaluated as its first fragment. `node`, `git` and `npm` installed under `C:\Program Files\...`
are all evaluated as `C:\Program`, and no `command(<name>)` rule matches any of them. Measured directly on Windows 10
with agy 1.1.12: with `command(node)` present in the allow list, a brief whose verification loop ran `node --check`
was auto-denied anyway.

### Write file glob error

Upstream issue #614 also reports that a glob in a `write_file` rule - `write_file(C:\path\*)` - raises "globs not supported"
and blocks the agent's actions entirely. Directory rules are recursive already, so the glob is unnecessary as well as harmful.

### Workarounds and caveats

The workarounds documented in issue #614:

- **Command permissions:** `command(*)` matches commands where the executable path contains spaces. A deny list still
  applies over `command(*)`, because deny is evaluated above allow. Note that `command(*)` widens permission to
  auto-approve all command execution.
- **Directory permissions:** Write directory paths literally without a wildcard, e.g. `write_file(C:\path)`.

If settings allow-rules cannot resolve the denial, ask the human before re-dispatching with `--dangerously-skip-permissions`;
that flag auto-approves every tool permission request and the run must be treated as full access.

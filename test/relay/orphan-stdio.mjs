import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A relay must settle when the implementer exits normally but leaves behind a detached
// grandchild that inherited the stdio pipes. "exit" fires; "close" does not, because the
// orphan still holds the pipes. A relay that settles only on "close" waits forever and
// writes no result.json, so the orchestrator sees a run that neither completed nor failed.
//
// The watchdog is not a backstop: a run without --timeout has none, and one with a timeout
// mislabels a successful run as "timeout".
export async function runOrphanStdio(h) {
for (const skill of h.SKILLS) {
  const outDir = join(h.scratch, `out-orphanmx-${skill}`);
  const grandPidFile = join(h.scratch, `grandpid-orphanmx-${skill}`);
  const run = spawnSync(process.execPath,
    [h.relayPath(skill), "--brief", h.briefPath,
      "--cd", h.freshRepo(`work-orphanmx-${skill}`), "--out-dir", outDir, ...h.EXTRA_ARGS[skill]],
    {
      env: { ...h.baseEnv, SMOKE_MODE: "orphan-holds-stdio", SMOKE_GRAND_PID_FILE: grandPidFile },
      encoding: "utf8",
      timeout: 25_000,
    });
  h.check(`${skill} orphan: the relay exits instead of waiting on the held pipes`,
    run.signal === null);
  h.check(`${skill} orphan: result.json exists`, existsSync(join(outDir, "result.json")));
  // The relay does not own a detached orphan on the normal-exit path; do not leak it.
  if (existsSync(grandPidFile)) {
    try { process.kill(Number(readFileSync(grandPidFile, "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
}
}

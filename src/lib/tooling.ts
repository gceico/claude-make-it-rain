'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Detect/install architecture for the Optimize release's core tooling set:
 * RTK, Caveman, Ponytail. Pure-ish (Electron-free): every process spawn goes
 * through an INJECTABLE command runner, so this module is unit-testable with
 * a fake runner; the real runner is wired up in main.ts (mirroring the
 * `execFile` static-argv pattern already used by `runUpdate()` — literal
 * argv arrays, never a shell string with interpolated input).
 *
 * Commands confirmed with the orchestrator (2026-07-23, refined same day):
 *   - RTK install is AVAILABILITY-AWARE, tried in this order:
 *       1. `brew install rtk` if brew is on PATH.
 *       2. The official universal installer (no package manager, no sudo,
 *          drops a prebuilt binary in ~/.local/bin) — the ONE deliberate
 *          curl|sh exception, run as a STATIC string via
 *          `sh -c '<literal pipeline>'` (zero interpolation; shown verbatim
 *          in the confirm sheet's "Show commands" detail).
 *       3. `cargo install --git https://github.com/rtk-ai/rtk` if cargo is
 *          present and neither of the above applied.
 *     RTK detection is PATH-aware AND location-aware: `rtk --version` first;
 *     if that fails, check ~/.local/bin/rtk (honoring RTK_INSTALL_DIR) —
 *     present-but-not-on-PATH is reported distinctly so the UI can tell the
 *     user to add ~/.local/bin to PATH rather than claiming "not installed".
 *   - Caveman and Ponytail are installed via skills.sh (`npx skills add <repo>
 *     --global --all`), which installs into ~/.agents/skills and symlinks into
 *     EVERY detected agent dir — Claude Code and Codex both — which is why it
 *     is preferred over the Claude-only plugin route in multi-agent setups.
 *     Detection accepts any of: a skills.sh install (~/.agents/skills,
 *     ~/.claude/skills, ~/.codex/skills, or the ~/.agents/.skill-lock.json
 *     source), a Claude Code plugin (`claude plugin list` / ~/.claude/plugins),
 *     so a user who installed them by hand either way is not asked again.
 *   - RTK's savings comes from `rtk gain --all --format json` — an
 *     authoritative saved-TOKEN count (summary.total_saved), priced to USD in
 *     score.ts's parseRtkGainJson.
 *
 * Both output formats empirically confirmed (2026-07-23): `claude plugin list`
 * prints the exact `<id>@<id>` form the detector matches; `rtk gain` nests the
 * token figure under `summary.total_saved`.
 */

export type ToolId = 'rtk' | 'caveman' | 'ponytail';

export const TOOL_IDS: ToolId[] = ['rtk', 'caveman', 'ponytail'];

export const TOOL_LABELS: Record<ToolId, string> = {
  rtk: 'RTK',
  caveman: 'Caveman',
  ponytail: 'Ponytail',
};

/** Result of running one command via the injectable runner. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable command runner: (argv[0], argv[1:]) -> result. Every caller in
 *  this module passes a fully static argv array (mirrors main.ts's
 *  execFile-based runUpdate()) — the ONE exception is RTK's official
 *  installer fallback, which is a static `sh -c '<literal pipeline>'` (no
 *  interpolated input; see TOOL_COMMANDS.rtk.installUniversal). */
export type CommandRunner = (
  cmd: string,
  args: string[]
) => Promise<CommandResult>;

/** Detected/install state for one tool. `pathIssue` is set only for RTK when
 *  the binary exists on disk (e.g. ~/.local/bin/rtk) but isn't resolvable via
 *  PATH, so the UI can say "installed, but add ~/.local/bin to PATH" instead
 *  of incorrectly claiming "not installed". */
export interface DetectedTool {
  installed: boolean;
  version: string | null;
  pathIssue?: string;
}

export type ToolingDetection = Record<ToolId, DetectedTool>;

// ── TOOL_COMMANDS ───────────────────────────────────────────────────────────
// Static, interpolation-free argv arrays — no user input is ever concatenated
// in. Shown verbatim in the Optimize confirm sheet's "Show commands"
// disclosure, so what's here IS what runs.
const RTK_UNIVERSAL_INSTALL_PIPELINE =
  'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh';

export const TOOL_COMMANDS = {
  rtk: {
    detect: [['rtk', ['--version']]] as [string, string[]][],
    // Official installer drops the binary here (honors RTK_INSTALL_DIR).
    defaultInstallDir: () => path.join(os.homedir(), '.local', 'bin'),
    installBrew: ['brew', ['install', 'rtk']] as [string, string[]],
    // The ONE deliberate curl|sh exception: a static string, zero
    // interpolation, run via `sh -c` (not a shell built from user input).
    installUniversal: ['sh', ['-c', RTK_UNIVERSAL_INSTALL_PIPELINE]] as [
      string,
      string[],
    ],
    installCargo: [
      'cargo',
      ['install', '--git', 'https://github.com/rtk-ai/rtk'],
    ] as [string, string[]],
    // Authoritative savings KPI — no estimation needed for RTK.
    gain: ['rtk', ['gain', '--all', '--format', 'json']] as [string, string[]],
    // brew is the only tool with a clean outdated/upgrade signal (rtk).
    outdated: ['brew', ['outdated', 'rtk']] as [string, string[]],
    upgrade: ['brew', ['upgrade', 'rtk']] as [string, string[]],
  },
  caveman: {
    skillsRepo: 'JuliusBrussee/caveman',
    skillDirName: 'caveman',
    marketplaceRepo: 'JuliusBrussee/caveman',
    pluginId: 'caveman@caveman',
    marketplaceDirName: 'JuliusBrussee/caveman',
    pluginDirName: 'caveman',
  },
  ponytail: {
    skillsRepo: 'DietrichGebert/ponytail',
    skillDirName: 'ponytail',
    marketplaceRepo: 'DietrichGebert/ponytail',
    pluginId: 'ponytail@ponytail',
    marketplaceDirName: 'DietrichGebert/ponytail',
    pluginDirName: 'ponytail',
  },
};

/** skills.sh install argv for a repo: global scope, every skill, every detected
 *  agent (Claude Code AND Codex), non-interactive. `--all` is skills.sh's own
 *  shorthand for `--skill '*' --agent '*' -y`. Static but for the repo slug,
 *  which is a literal from TOOL_COMMANDS — never user input. */
export function skillsInstallArgv(repo: string): string[] {
  return ['npx', '-y', 'skills', 'add', repo, '--global', '--all'];
}

/** The package-manager bin dirs a GUI/Finder-launched app is missing from its
 *  minimal PATH. Also the filesystem-fallback search dirs for a `rtk` binary. */
export function commonBinDirs(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): string[] {
  if (platform === 'win32') return [];
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    '/usr/bin',
    '/bin',
  ];
}

/** Prepend the common package-manager bin dirs (deduped) to `currentPath`.
 *  A Finder/GUI-launched Electron app inherits a minimal PATH that omits
 *  /opt/homebrew/bin, ~/.local/bin, etc., so `rtk`/`claude`/`brew`/`which`
 *  all fail even when installed — this is the root cause of tools not being
 *  detected. No-op on Windows (returns currentPath unchanged). */
export function enrichPath(
  currentPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): string {
  if (platform === 'win32') return currentPath || '';
  const existing = (currentPath || '').split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...commonBinDirs(platform, homeDir), ...existing]) {
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(path.delimiter);
}

/** Pull a version-looking token (e.g. "1.2.3") out of arbitrary CLI output. */
function extractVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

async function tryRun(
  runner: CommandRunner,
  argv: [string, string[]]
): Promise<CommandResult | null> {
  try {
    return await runner(argv[0], argv[1]);
  } catch {
    return null; // the runner itself is expected not to throw, but be defensive
  }
}

/** Whether a binary resolves on PATH, probed via a lightweight `which`
 *  (`where` on Windows) call through the injected runner. Never throws. */
async function onPath(runner: CommandRunner, bin: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = await tryRun(runner, [probe, [bin]]);
  return !!result && result.code === 0;
}

/** Detect RTK: `rtk --version` first (PATH-resolved); if that fails, check
 *  for the binary at its known install location (~/.local/bin by default,
 *  honoring RTK_INSTALL_DIR) so a real install that's merely off-PATH is
 *  reported as installed-with-a-path-issue rather than "not installed". */
export async function detectRtk(
  runner: CommandRunner,
  binDirs: string[] = commonBinDirs()
): Promise<DetectedTool> {
  for (const argv of TOOL_COMMANDS.rtk.detect) {
    const result = await tryRun(runner, argv);
    if (result && result.code === 0) {
      return {
        installed: true,
        version: extractVersion(result.stdout) || extractVersion(result.stderr),
      };
    }
  }

  // Filesystem fallback: check the usual install/bin dirs for an `rtk` binary
  // (RTK_INSTALL_DIR first, then brew/local/cargo dirs) so a real install
  // that's merely off the GUI app's minimal PATH is reported installed.
  const dirs = [
    ...(process.env.RTK_INSTALL_DIR ? [process.env.RTK_INSTALL_DIR] : []),
    ...binDirs,
  ];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, 'rtk'))) {
        return {
          installed: true,
          version: null,
          pathIssue: `rtk is installed at ${dir} but not on PATH — add it to your shell PATH to use the \`rtk\` command directly.`,
        };
      }
    } catch {
      /* best-effort filesystem check only */
    }
  }
  return { installed: false, version: null };
}

/** Whether skills.sh installed this tool: the skill dir under ~/.agents/skills
 *  (its store) or either agent dir it symlinks into, or — for a partial
 *  install where the same-named skill was skipped — any lock entry whose
 *  `source` is the tool's repo. Filesystem-only, never throws. */
function detectSkillsInstall(tool: 'caveman' | 'ponytail', homeDir: string) {
  const spec = TOOL_COMMANDS[tool];
  const dirs = [
    path.join(homeDir, '.agents', 'skills'),
    path.join(homeDir, '.claude', 'skills'),
    path.join(homeDir, '.codex', 'skills'),
  ];
  try {
    if (dirs.some((d) => fs.existsSync(path.join(d, spec.skillDirName))))
      return true;
    const lockPath = path.join(homeDir, '.agents', '.skill-lock.json');
    if (!fs.existsSync(lockPath)) return false;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Object.values(lock?.skills ?? {}).some(
      (entry) => (entry as { source?: string })?.source === spec.skillsRepo
    );
  } catch {
    return false; // best-effort filesystem/JSON check only
  }
}

/** Detect Caveman/Ponytail however the user got them: a skills.sh install
 *  (the route this app installs by, and the one that covers Claude Code AND
 *  Codex), else a Claude Code plugin — `claude plugin list` output containing
 *  the plugin id, with a filesystem fallback under ~/.claude/plugins so
 *  detection survives a change in the CLI's list output format. `homeDir` is
 *  injectable for tests. */
export async function detectAgentTool(
  tool: 'caveman' | 'ponytail',
  runner: CommandRunner,
  homeDir: string = os.homedir()
): Promise<DetectedTool> {
  const spec = TOOL_COMMANDS[tool];
  if (detectSkillsInstall(tool, homeDir))
    return { installed: true, version: null };

  const result = await tryRun(runner, ['claude', ['plugin', 'list']]);
  if (result && result.code === 0 && result.stdout.includes(spec.pluginId)) {
    return { installed: true, version: extractVersion(result.stdout) };
  }
  if (
    result &&
    result.code === 0 &&
    result.stdout.toLowerCase().includes(tool)
  ) {
    return { installed: true, version: null };
  }

  // Filesystem fallback: a plugin dir under ~/.claude/plugins is a reasonable
  // "installed" proxy independent of the CLI's list output shape.
  try {
    const pluginsDir = path.join(homeDir, '.claude', 'plugins');
    const marketplacePath = path.join(pluginsDir, spec.marketplaceDirName);
    const pluginPath = path.join(pluginsDir, spec.pluginDirName);
    if (fs.existsSync(marketplacePath) || fs.existsSync(pluginPath)) {
      return { installed: true, version: null };
    }
  } catch {
    /* best-effort fallback only */
  }
  return { installed: false, version: null };
}

/** Detect all supported tools. Runs detectors concurrently; a single failing
 *  detector never blocks the others (each detector never throws). */
export async function detectTooling(
  runner: CommandRunner,
  homeDir: string = os.homedir()
): Promise<ToolingDetection> {
  const [rtk, caveman, ponytail] = await Promise.all([
    detectRtk(runner),
    detectAgentTool('caveman', runner, homeDir),
    detectAgentTool('ponytail', runner, homeDir),
  ]);
  return { rtk, caveman, ponytail };
}

/** One step of an install plan: a human-readable description plus the exact,
 *  static argv that will run (shown in the "Show commands" disclosure). */
export interface InstallStep {
  tool: ToolId;
  label: string;
  argv: string[];
}

/**
 * Choose RTK's install command, availability-aware, in the confirmed order:
 *   1. `brew install rtk` if brew is on PATH (clean argv, gets updates via
 *      brew).
 *   2. Else the official universal installer — works with no package
 *      manager and no sudo, so it is always viable and is therefore the
 *      fallback whenever brew is absent (regardless of cargo).
 *   3. `cargo install --git …` is kept in TOOL_COMMANDS as a documented third
 *      option, but since the universal installer is always available it is
 *      never auto-selected by this chooser — `hasCargo` is accepted for
 *      forward-compatibility (e.g. a future "prefer cargo" user setting)
 *      without changing today's decision.
 */
export function chooseRtkInstallStep(
  hasBrew: boolean,
  _hasCargo: boolean = false
): InstallStep {
  const [cmd, args] = hasBrew
    ? TOOL_COMMANDS.rtk.installBrew
    : TOOL_COMMANDS.rtk.installUniversal;
  return { tool: 'rtk', label: TOOL_LABELS.rtk, argv: [cmd, ...args] };
}

/**
 * Build the STATIC, interpolation-free install plan for the given tools
 * (already-installed tools should be filtered out by the caller — see
 * habits.ts's `*-missing` detectors / analytics-store's toolingState).
 * Probes `brew`/`cargo` availability via the injected runner to pick RTK's
 * install path (brew > universal installer > cargo); every resulting argv is
 * a literal from TOOL_COMMANDS, never built from user input.
 */
export async function installPlan(
  tools: ToolId[],
  runner: CommandRunner
): Promise<InstallStep[]> {
  const steps: InstallStep[] = [];
  for (const tool of tools) {
    if (tool === 'rtk') {
      const [hasBrew, hasCargo] = await Promise.all([
        onPath(runner, 'brew'),
        onPath(runner, 'cargo'),
      ]);
      steps.push(chooseRtkInstallStep(hasBrew, hasCargo));
    } else {
      steps.push({
        tool,
        label: TOOL_LABELS[tool],
        argv: skillsInstallArgv(TOOL_COMMANDS[tool].skillsRepo),
      });
    }
  }
  return steps;
}

export interface InstallResult {
  tool: ToolId;
  argv: string[];
  ok: boolean;
  result: CommandResult | null;
}

/**
 * Execute an install plan step by step via the injected runner. Once a step
 * for a given tool fails, subsequent steps for THAT tool are skipped (e.g. no
 * point running `plugin install` if `marketplace add` failed), but other
 * tools keep going. Never throws — a failing step is reported in the
 * returned array, not as an exception (mirrors runUpdate()'s graceful
 * failure path: the caller is expected to notify(), never crash).
 */
export async function runInstallPlan(
  steps: InstallStep[],
  runner: CommandRunner
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  const failedTools = new Set<ToolId>();
  for (const step of steps) {
    if (failedTools.has(step.tool)) {
      results.push({
        tool: step.tool,
        argv: step.argv,
        ok: false,
        result: null,
      });
      continue;
    }
    const result = await tryRun(runner, [step.argv[0]!, step.argv.slice(1)]);
    const ok = !!result && result.code === 0;
    if (!ok) failedTools.add(step.tool);
    results.push({ tool: step.tool, argv: step.argv, ok, result });
  }
  return results;
}

/** Run `rtk gain --all --format json` and return its parsed JSON (or null on
 *  a non-zero exit or unparseable output — never throws). Interpreting the
 *  shape into a USD figure is score.ts's parseRtkGainJson job, not this one. */
export async function fetchRtkGainJson(
  runner: CommandRunner
): Promise<unknown | null> {
  const result = await tryRun(runner, TOOL_COMMANDS.rtk.gain);
  if (!result || result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { buildRemedyCommand } from "../../src/contracts/remedy-command";

printOrigin("../../src/contracts/remedy-command.ts", import.meta.dir);

type Value = Parameters<typeof buildRemedyCommand>[1][string];

const BS = "\\";
const SHELL_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;

// Contract §4: PowerShell ends a single-quoted string at these five characters.
const QUOTES = ["'", "\u2018", "\u2019", "\u201A", "\u201B"];
const REFUSED_CHARS = ['"', "\u201C", "\u201D", "\u201E", "\u0000", "\u0009", "\u001F", "\u007F", "\u0085", "\u009F"];
const LITERAL_SPECIALS = [...QUOTES, "$(Write-Output pwned)", "a b", "\u00e9\u4e2d", "`$x", "@(1)", ";&|", "\u00a0", "\u3000"];

const windows = (kind: string, text: string | Uint8Array): Value => ({ kind, text, form: "windows" }) as Value;
const linux = (kind: string, text: string | Uint8Array): Value => ({ kind, text, form: "linux" }) as Value;
const plain = (kind: string, text: string | Uint8Array): Value => ({ kind, text }) as Value;
const gitReported = (text: string): Value => ({ kind: "path", text, form: "git-reported" }) as Value;

const T_ADD = "& {git} --literal-pathspecs -C {root} add -- {path}";
const T_BRANCH = "& {git} --no-lazy-fetch -C {submodule} branch {branch} {commit}";
const T_GITDIR = "& {git} --no-lazy-fetch --git-dir {gitDir} --work-tree {gitDir} fetch {remote}";
const T_SAFE = "& {git} config --global --add safe.directory {safe}";
const T_WSL = `& 'C:${BS}Windows${BS}System32${BS}wsl.exe' --distribution {distro} --cd / --exec {git} --literal-pathspecs -C {linuxRoot} add -- {path}`;

function valuesWith(special: string, gitPath: string): Record<string, Value> {
  return {
    git: windows("gitPath", gitPath),
    root: windows("worktreeRoot", `C:${BS}Arbareto Test${BS}r${special}x`),
    path: windows("path", `src/a${special}b.txt`),
    submodule: windows("submoduleWorktree", `C:${BS}Arbareto Test${BS}sub${special}x`),
    gitDir: windows("gitDirectory", `C:${BS}Arbareto Test${BS}.git${BS}modules${BS}m${special}x`),
    remote: plain("remoteName", `orig${special}in`),
    branch: plain("branchName", `arbareto-saved-${special}1`),
    commit: plain("commitId", `0123456789ab${special}`),
    distro: plain("distroName", `Ubuntu${special}24`),
    linuxRoot: linux("worktreeRoot", `/home/u/r${special}x`),
    safe: gitReported(`C:/Users/u/r${special}x`),
  };
}

function build(template: string, values: Record<string, Value>): string {
  const result = buildRemedyCommand(template, values);
  if (result.command === null) throw new Error(`refused ${result.refused} for ${template}`);
  return result.command;
}

const textOf = (value: Value) => {
  const text = (value as { text: string | Uint8Array }).text;
  return typeof text === "string" ? text : new TextDecoder().decode(text);
};

// The single-quoted constants of the template, in order, with each value as the parser must read it.
function expectedConstants(template: string, values: Record<string, Value>): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(/\{(\w+)\}|'([^']*)'/g)) {
    out.push(match[1] !== undefined ? textOf(values[match[1]]) : match[2]);
  }
  return out;
}

const owned: string[] = [];
const ownedDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "arbareto-remedy-"));
  owned.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});

describe("quoting", () => {
  const kinds: Array<[string, (t: string) => Value, string]> = [
    ["gitPath", (t) => windows("gitPath", t), `C:${BS}Tools${BS}g`],
    ["worktreeRoot", (t) => windows("worktreeRoot", t), `C:${BS}repo`],
    ["path", (t) => windows("path", t), "src/a"],
    ["submoduleWorktree", (t) => windows("submoduleWorktree", t), `C:${BS}repo${BS}lib`],
    ["gitDirectory", (t) => windows("gitDirectory", t), `C:${BS}repo${BS}.git`],
    ["remoteName", (t) => plain("remoteName", t), "origin"],
    ["branchName", (t) => plain("branchName", t), "main"],
    ["commitId", (t) => plain("commitId", t), "0123456789ab"],
    ["distroName", (t) => plain("distroName", t), "Ubuntu"],
  ];

  for (const [kind, make, base] of kinds) {
    test.each(QUOTES.map((q) => [q]))(`${kind}: %j is doubled inside single quotes`, (quote) => {
      const text = `${base}${quote}x`;
      expect(build("& x {v}", { v: make(text) })).toBe(`& x '${base}${quote}${quote}x'`);
    });

    test(`${kind}: a value with every quote character doubles each one`, () => {
      const text = `${base}${QUOTES.join("")}`;
      expect(build("& x {v}", { v: make(text) })).toBe(`& x '${base}${QUOTES.map((q) => q + q).join("")}'`);
    });

    test.each(REFUSED_CHARS.map((c) => [c]))(`${kind}: a value with %j gives no command and names the kind`, (char) => {
      expect(buildRemedyCommand("& x {v}", { v: make(`${base}${char}x`) })).toEqual({ command: null, refused: kind });
    });

    test(`${kind}: invalid UTF-8 bytes give no command and name the kind`, () => {
      const bytes = new Uint8Array([...new TextEncoder().encode(base), 0xff, 0x61]);
      expect(buildRemedyCommand("& x {v}", { v: make(bytes as unknown as string) })).toEqual({ command: null, refused: kind });
    });

    test(`${kind}: valid UTF-8 bytes build the same command as the text`, () => {
      const text = `${base}\u00e9'`;
      const fromBytes = buildRemedyCommand("& x {v}", { v: make(new TextEncoder().encode(text) as unknown as string) });
      expect(fromBytes).toEqual({ command: build("& x {v}", { v: make(text) }) });
    });
  }

  test("the refusal names the refused value when others are valid", () => {
    expect(
      buildRemedyCommand(T_ADD, {
        git: windows("gitPath", `C:${BS}Git${BS}cmd${BS}git.exe`),
        root: windows("worktreeRoot", `C:${BS}repo`),
        path: windows("path", 'a"b'),
      }),
    ).toEqual({ command: null, refused: "path" });
  });

  test("the template text stays unchanged around the values", () => {
    expect(
      build(T_ADD, {
        git: windows("gitPath", `C:${BS}Program Files${BS}Git${BS}cmd${BS}git.exe`),
        root: windows("worktreeRoot", `D:${BS}w`),
        path: windows("path", "a.txt"),
      }),
    ).toBe(`& 'C:${BS}Program Files${BS}Git${BS}cmd${BS}git.exe' --literal-pathspecs -C 'D:${BS}w' add -- 'a.txt'`);
  });
});

describe("trailing U+005C", () => {
  test.each([[`x ${BS}`], [`x ${BS}${BS}`], [`x${BS}`], [`x\u00a0${BS}`], [`x\u3000${BS}`]])(
    "remote name %j gives no command",
    (name) => {
      expect(buildRemedyCommand("& x fetch {v}", { v: plain("remoteName", name) })).toEqual({ command: null, refused: "remoteName" });
    },
  );

  test.each([["branchName"], ["commitId"], ["distroName"]])("%s ending in U+005C gives no command", (kind) => {
    expect(buildRemedyCommand("& x {v}", { v: plain(kind, `a${BS}`) })).toEqual({ command: null, refused: kind });
  });

  test.each([
    [`C:${BS}repo${BS}`, `C:${BS}repo`],
    [`C:${BS}repo${BS}${BS}`, `C:${BS}repo`],
    [`C:${BS}repo/`, `C:${BS}repo`],
    [`C:${BS}repo${BS}/${BS}`, `C:${BS}repo`],
    [`C:${BS}Arbareto Test${BS}`, `C:${BS}Arbareto Test`],
    [`D:${BS}`, `D:${BS}`],
    [`D:${BS}${BS}`, `D:${BS}`],
    [`${BS}${BS}server${BS}share${BS}`, `${BS}${BS}server${BS}share`],
  ])("Windows path %j becomes %j", (input, output) => {
    for (const kind of ["gitPath", "worktreeRoot", "path", "submoduleWorktree", "gitDirectory"]) {
      expect(build("& x {v}", { v: windows(kind, input) })).toBe(`& x '${output}'`);
    }
  });

  test("a Windows path keeps every other character", () => {
    const input = `C:${BS}a${BS}${BS}b/c${BS}.${BS}d`;
    expect(build("& x {v}", { v: windows("worktreeRoot", input) })).toBe(`& x '${input}'`);
  });

  test("a Linux path keeps its form", () => {
    expect(build("& x {v}", { v: linux("worktreeRoot", "/home/u/repo/") })).toBe("& x '/home/u/repo/'");
    expect(build("& x {v}", { v: linux("path", "dir/") })).toBe("& x 'dir/'");
  });

  test("a Linux path ending in U+005C gives no command", () => {
    expect(buildRemedyCommand("& x {v}", { v: linux("worktreeRoot", `/home/u/a${BS}`) })).toEqual({
      command: null,
      refused: "worktreeRoot",
    });
  });

  test("the safe.directory path keeps its form", () => {
    expect(build(T_SAFE.replace("{git}", "x"), { safe: gitReported("C:/Users/u/repo/") })).toBe(
      "& x config --global --add safe.directory 'C:/Users/u/repo/'",
    );
    expect(build("& x {v}", { v: gitReported("%(prefix)///server/share/r") })).toBe("& x '%(prefix)///server/share/r'");
  });

  test("the safe.directory path ending in U+005C gives no command", () => {
    expect(buildRemedyCommand("& x {v}", { v: gitReported(`C:${BS}repo${BS}`) })).toEqual({ command: null, refused: "path" });
  });
});

// PowerShell checks. Each part skips and names the missing capability when its tool is absent.
const SHELLS: Array<[string, string | null]> = [
  ["pwsh", Bun.which("pwsh")],
  ["Windows PowerShell 5.1", Bun.which("powershell")],
];
const GIT = process.env.ARBARETO_TEST_GIT ?? Bun.which("git");

const PARSE_SCRIPT = [
  "$cmds = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARBARETO_CMDS)) -split [string][char]10",
  "foreach ($c in $cmds) {",
  "$t = $null; $e = $null",
  "$ast = [System.Management.Automation.Language.Parser]::ParseInput($c, [ref]$t, [ref]$e)",
  "$vals = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.StringConstantType -eq 'SingleQuoted' }, $true) | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Value)) })",
  "[Console]::Out.WriteLine([string]$e.Count + '|' + ($vals -join ','))",
  "}",
].join(" ; ");

const decodeB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const shellText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function shellVersion(shell: string): string {
  const r = Bun.spawnSync([shell, "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { timeout: SHELL_TIMEOUT_MS });
  return shellText(r.stdout).trim();
}

function parseCases(): Array<{ command: string; expected: string[] }> {
  const gitPath = `C:${BS}Program Files${BS}Git${BS}cmd${BS}git.exe`;
  const cases: Array<{ command: string; expected: string[] }> = [];
  for (const special of LITERAL_SPECIALS) {
    const values = valuesWith(special, special === "a b" ? gitPath : `C:${BS}Tools${BS}g${special}t${BS}git.exe`);
    for (const template of [T_ADD, T_BRANCH, T_GITDIR, T_SAFE, T_WSL]) {
      cases.push({ command: build(template, values), expected: expectedConstants(template, values) });
    }
  }
  const driveRoot = { git: windows("gitPath", gitPath), root: windows("worktreeRoot", `D:${BS}`), path: windows("path", "a") };
  cases.push({ command: build(T_ADD, driveRoot), expected: [gitPath, `D:${BS}`, "a"] });
  return cases;
}

describe("PowerShell parser", () => {
  for (const [name, shell] of SHELLS) {
    if (!shell) console.log(`SKIP T261 parser check in ${name}: missing capability ${name}`);
    test.skipIf(!shell)(
      `each value parses as one single-quoted constant in ${name}`,
      () => {
        const cases = parseCases();
        for (let at = 0; at < cases.length; at += 20) {
          const chunk = cases.slice(at, at + 20);
          const encoded = Buffer.from(chunk.map((c) => c.command).join("\n"), "utf8").toString("base64");
          const run = Bun.spawnSync([shell as string, "-NoProfile", "-Command", PARSE_SCRIPT], {
            env: { ...process.env, ARBARETO_CMDS: encoded },
            timeout: SHELL_TIMEOUT_MS,
          });
          expect(shellText(run.stderr)).toBe("");
          expect(run.exitCode).toBe(0);
          const lines = shellText(run.stdout).split(/\r?\n/).filter((l) => l.length > 0);
          expect(lines.length).toBe(chunk.length);
          chunk.forEach((c, i) => {
            const [errors, list] = lines[i].split("|");
            expect({ command: c.command, errors }).toEqual({ command: c.command, errors: "0" });
            const constants = list.length === 0 ? [] : list.split(",").map(decodeB64);
            expect({ command: c.command, constants }).toEqual({ command: c.command, constants: c.expected });
          });
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

// Parses the output of `git rev-parse --sq-quote`.
function parseSqQuote(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  const line = text.replace(/\r?\n$/, "");
  while (at < line.length) {
    if (line[at] === " ") {
      at++;
      continue;
    }
    if (line[at] !== "'") throw new Error(`unexpected sq-quote text at ${at}: ${JSON.stringify(line)}`);
    let value = "";
    at++;
    for (;;) {
      const end = line.indexOf("'", at);
      if (end < 0) throw new Error(`unterminated sq-quote: ${JSON.stringify(line)}`);
      value += line.slice(at, end);
      at = end + 1;
      if (line.startsWith("\\''", at)) {
        value += "'";
        at += 3;
        continue;
      }
      break;
    }
    out.push(value);
  }
  return out;
}

// Inserts `rev-parse --sq-quote` after the Git path, so Git only echoes the later arguments.
function echoTemplate(template: string): string {
  const fromGit = template.slice(template.indexOf("{git}"));
  return `& ${fromGit.replace("{git}", "{git} rev-parse --sq-quote")}`;
}

function intendedArguments(template: string, values: Record<string, Value>, formed: Record<string, string> = {}): string[] {
  const after = template.slice(template.indexOf("{git}") + "{git}".length).trim();
  return after.split(" ").map((token) => {
    const name = /^\{(\w+)\}$/.exec(token)?.[1];
    if (!name) return token;
    return formed[name] ?? textOf(values[name]);
  });
}

function argumentCases(gitPath: string) {
  const cases: Array<{ command: string; expected: string[] }> = [];
  for (const special of LITERAL_SPECIALS) {
    const values = valuesWith(special, gitPath);
    for (const template of [T_ADD, T_BRANCH, T_GITDIR, T_SAFE, T_WSL]) {
      cases.push({ command: build(echoTemplate(template), values), expected: intendedArguments(template, values) });
    }
  }
  for (const [root, formed] of [
    [`C:${BS}Arbareto Test${BS}repo${BS}`, `C:${BS}Arbareto Test${BS}repo`],
    [`C:${BS}Arbareto\u00a0Test${BS}repo${BS}${BS}`, `C:${BS}Arbareto\u00a0Test${BS}repo`],
    [`D:${BS}`, `D:${BS}`],
  ]) {
    const values = { git: windows("gitPath", gitPath), root: windows("worktreeRoot", root), path: windows("path", "a b") };
    cases.push({ command: build(echoTemplate(T_ADD), values), expected: intendedArguments(T_ADD, values, { root: formed }) });
  }
  return cases;
}

describe("argument check", () => {
  for (const [name, shell] of SHELLS) {
    if (!shell) console.log(`SKIP T261 argument check in ${name}: missing capability ${name}`);
    if (!GIT) console.log(`SKIP T261 argument check in ${name}: missing capability git`);
    test.skipIf(!shell || !GIT)(
      `Git receives each intended argument list through ${name}`,
      () => {
        const dir = ownedDir();
        const globalConfig = join(dir, "gitconfig");
        writeFileSync(globalConfig, "");
        const cases = argumentCases(GIT as string);
        const lines = ["[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false"];
        cases.forEach((c, i) => {
          lines.push(`[Console]::Out.WriteLine('@@${i}')`, c.command);
        });
        const script = join(dir, "argument-check.ps1");
        writeFileSync(script, "\uFEFF" + lines.join("\r\n") + "\r\n", "utf8");
        const run = Bun.spawnSync([shell as string, "-NoProfile", "-File", script], {
          cwd: dir,
          env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
          timeout: SHELL_TIMEOUT_MS,
        });
        expect(shellText(run.stderr)).toBe("");
        expect(run.exitCode).toBe(0);
        const blocks = shellText(run.stdout).split(/^@@\d+\r?\n/m).slice(1);
        expect(blocks.length).toBe(cases.length);
        cases.forEach((c, i) => {
          expect({ command: c.command, received: parseSqQuote(blocks[i]) }).toEqual({ command: c.command, received: c.expected });
        });
        const gitVersion = shellText(Bun.spawnSync([GIT as string, "version"], { timeout: SHELL_TIMEOUT_MS }).stdout).trim();
        console.log(`OBSERVATION T261: ${name} ${shellVersion(shell as string)} passed ${cases.length} argument checks`);
        console.log(`OBSERVATION T261: ${gitVersion} at ${GIT}`);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

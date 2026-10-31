// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T004: the WSL facts L1 to L7 of research.md R14 with Perl snippets in the owned distro folder, and the G9 and G10 case list of `tests/git/revert-facts.ts` with the distro Git.
// Each fact prints `OBSERVATION T004` lines. A `match=false` line is a finding for research.md R15, not a failure. Run this file alone on the host.

import { expect, test } from "bun:test";
import { obs, observationLine, type Observation } from "../git/fact-runner";
import { gitRun } from "../git/remote-fixtures";
import { factLines, REVERT_FACTS, revertGitVersion, type FileState, type RevertHost } from "../git/revert-facts";
import { distroGitHost, sh } from "./fixtures";
import { inDistro, useWslFolder, WSL_ENV, WSL_EXE, wslExec, wslHost, wslTest, type WslCapability, type WslHost } from "./wsl-host";
import { printOrigin } from "../origin";

printOrigin("../git/revert-facts.ts", import.meta.dir);
printOrigin("./revert-facts.test.ts", import.meta.dir);
useWslFolder();

const TASK = "T004";
const NEEDS: WslCapability[] = ["distro-git-2.55", "wsl-fixture-fs-id", "perl"];
const FACT_MS = 900_000;
const STAGE_MS = 30_000;
const GLOBAL_TEXT = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";
const NUL = "\0";

const owned = (w: WslHost, path: string) => {
  if (!path.startsWith(`${w.folder}/`)) throw new Error(`outside the owned folder: ${path}`);
  return path;
};

// ---- The distro host of the G9 and G10 cases ----

let revertHost: RevertHost | undefined;
function hostOf(w: WslHost): RevertHost {
  if (revertHost !== undefined) return revertHost;
  const git = distroGitHost(w, "revert-facts", GLOBAL_TEXT);
  revertHost = {
    git,
    tree(dir) {
      const r = sh(w, 'cd -- "$1" && find . -type f -print0 | xargs -0 -r sha256sum -z --', [owned(w, dir)]);
      const digests: Record<string, string> = {};
      for (const record of Buffer.from(r.bytes).toString("utf8").split(NUL)) {
        if (record === "") continue;
        const m = /^([0-9a-f]{64}) [ *]\.\/([\s\S]+)$/.exec(record);
        if (m === null) throw new Error(`sha256sum record refused: ${JSON.stringify(record)}`);
        digests[m[2]!] = m[1]!;
      }
      return Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
    stat(path) {
      // GNU stat `%s %a %y`, then `sha256sum`. Exit 3 means absent.
      const r = sh(w, '[ -e "$1" ] || exit 3; stat --format="%s %a %y" -- "$1" && sha256sum -- "$1"', [owned(w, path)], { allowExit: [0, 3] });
      if (r.exitCode === 3) return null;
      const m = /^(\d+) ([0-7]+) (.+)\n([0-9a-f]{64}) /.exec(r.stdout);
      if (m === null) throw new Error(`stat output refused: ${JSON.stringify(r.stdout)}`);
      const state: FileState = { size: Number(m[1]), sha256: m[4]!, mtime: m[3]!, mode: m[2]! };
      return state;
    },
    remove(path) {
      sh(w, 'rm -f -- "$1"', [owned(w, path)]);
    },
    names(dir) {
      const r = sh(w, "find \"$1\" -mindepth 1 -maxdepth 1 -printf '%f\\0'", [owned(w, dir)]);
      return Buffer.from(r.bytes).toString("utf8").split(NUL).filter((n) => n !== "");
    },
    // plan.md D9 keeps the old mode bits of an existing target.
    swap(target, bytes) {
      sh(w, 't="$(dirname -- "$1")/.arbareto-probe.tmp"; cat > "$t" && chmod --reference="$1" -- "$t" && mv -f -- "$t" "$1"', [owned(w, target)], { input: bytes });
    },
  };
  return revertHost;
}

// ---- Perl probes ----

// The shared Perl part. `AT_FDCWD` and `AT_SYMLINK_FOLLOW` come from include/uapi/linux/fcntl.h. The syscall numbers come from `syscall.ph` only.
const PRELUDE = String.raw`
use strict; use warnings;
use Fcntl qw(O_WRONLY O_RDONLY O_CREAT O_EXCL O_NOFOLLOW);
use POSIX ();
use JSON::PP;
use IO::Handle;
use constant { AT_FDCWD => -100, AT_SYMLINK_FOLLOW => 0x400 };
my $TMPFILE = eval { Fcntl::O_TMPFILE() };
my ($NR_SRC, %NR) = ('absent');
if (eval { require 'syscall.ph'; 1 }) { $NR_SRC = 'syscall.ph'; %NR = (linkat => main::SYS_linkat(), llistxattr => main::SYS_llistxattr(), setxattr => main::SYS_setxattr()); }
sub out { print JSON::PP->new->canonical->encode($_[0]), "\n"; }
sub names { my ($d) = @_; opendir(my $h, $d) or return (); my @n = sort grep { $_ ne '.' && $_ ne '..' } readdir $h; closedir $h; return @n; }
sub tmpfile { my ($d) = @_; return (undef, -1) unless defined $TMPFILE; sysopen(my $fh, $d, O_WRONLY | $TMPFILE, 0600) or return (undef, $! + 0); return ($fh, 0); }
sub name_it { my ($fh, $name) = @_; return -1 unless $NR{linkat}; my $r = syscall($NR{linkat}, AT_FDCWD, '/proc/self/fd/' . fileno($fh), AT_FDCWD, $name, AT_SYMLINK_FOLLOW); return $r == 0 ? 0 : $! + 0; }
sub slurp { my ($p) = @_; open(my $in, '<', $p) or return undef; local $/; my $t = <$in>; close $in; return $t; }
sub put { my ($p, $t) = @_; open(my $o, '>', $p) or die "open $p: $!"; print $o $t; close $o or die "close $p: $!"; }
`;

function folder(w: WslHost, name: string): string {
  const path = `${w.folder}/${name}`;
  inDistro(w.distro, ["/usr/bin/mkdir", "-p", "--", owned(w, path)]);
  return path;
}

function perl(w: WslHost, cwd: string, script: string, args: string[] = []): Record<string, any> {
  const r = wslExec(["--distribution", w.distro, "--cd", owned(w, cwd), "--exec", w.probe.paths.perl!, "-e", PRELUDE + script, "--", ...args], { timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`perl in ${cwd} exited ${r.exitCode}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, any>;
}

const L1 = String.raw`
my ($fh, $err) = tmpfile('.');
out({ tmpfile => defined $TMPFILE ? sprintf('%o', $TMPFILE) : undef, source => defined $TMPFILE ? 'Fcntl' : undef, open => defined $fh ? 1 : 0, errno => $err, names => [names('.')] });
`;

const L2 = String.raw`
my ($fh, $err) = tmpfile('.');
die "tmpfile $err" unless defined $fh;
syswrite($fh, "linked\n") == 7 or die "write $!";
my $e = name_it($fh, 'linked.txt');
my @st = lstat('linked.txt');
out({ nr => $NR{linkat}, source => $NR_SRC, arch => (POSIX::uname())[4], errno => $e, content => slurp('linked.txt'), uid => $<, fileUid => $st[4], links => $st[3] });
`;

// Stops at one stage and waits to be killed.
const L3 = String.raw`
my ($stage) = @ARGV;
$| = 1;
my ($fh, $err) = tmpfile('.');
die "tmpfile $err" unless defined $fh;
syswrite($fh, "new\n") == 4 or die "write $!";
$fh->sync or die "sync $!";
print "STAGE tmpfile $$\n";
if ($stage eq 'tmpfile') { sleep 60; exit 0; }
name_it($fh, '.arbareto-probe.tmp') == 0 or die "linkat";
print "STAGE linkat $$\n";
if ($stage eq 'linkat') { sleep 60; exit 0; }
rename('.arbareto-probe.tmp', 'target') or die "rename $!";
print "STAGE rename $$\n";
sleep 60;
`;

// The plan.md D9 sequence: O_TMPFILE, the mode copy, write, fsync, linkat, rename. `first` runs fchmod before the write, as the 005 `replace_one` runs chmod; `last` runs it after fsync.
const L4 = String.raw`
my %res;
for my $order ('first', 'last') {
  for my $m (0644, 0755, 0600, 02755) {
    my $name = sprintf('%s-m%o', $order, $m);
    put($name, "old\n");
    chmod($m, $name) or die "chmod $!";
    my @st = lstat($name);
    my $old = $st[2] & 07777;
    my ($fh, $err) = tmpfile('.');
    die "tmpfile $err" unless defined $fh;
    if ($order eq 'first') { chmod($old, $fh) or die "fchmod $!"; }
    syswrite($fh, "new\n") == 4 or die "write $!";
    $fh->sync or die "sync $!";
    if ($order eq 'last') { chmod($old, $fh) or die "fchmod $!"; }
    my $tmp = ".arbareto-$$-$name.tmp";
    name_it($fh, $tmp) == 0 or die "linkat";
    rename($tmp, $name) or die "rename $!";
    my @n = lstat($name);
    $res{$name} = { before => sprintf('%o', $old), after => sprintf('%o', $n[2] & 07777), content => slurp($name) };
  }
}
# chown(2): an unprivileged chown clears S_ISUID and S_ISGID. chown-first runs the gid copy before the write, chown-last after the mode copy.
for my $order ('chown-first', 'chown-last') {
  for my $m (02755, 04755) {
    my $name = sprintf('%s-m%o', $order, $m);
    put($name, "old\n");
    chmod($m, $name) or die "chmod $!";
    my @st = lstat($name);
    my ($old, $gid) = ($st[2] & 07777, $st[5]);
    my ($fh, $err) = tmpfile('.');
    die "tmpfile $err" unless defined $fh;
    if ($order eq 'chown-first') { chown(-1, $gid, $fh) or die "fchown $!"; }
    syswrite($fh, "new\n") == 4 or die "write $!";
    $fh->sync or die "sync $!";
    chmod($old, $fh) or die "fchmod $!";
    if ($order eq 'chown-last') { chown(-1, $gid, $fh) or die "fchown $!"; }
    my $fstat = (stat($fh))[2] & 07777;
    my $tmp = ".arbareto-$$-$name.tmp";
    name_it($fh, $tmp) == 0 or die "linkat";
    rename($tmp, $name) or die "rename $!";
    my @n = lstat($name);
    $res{$name} = { before => sprintf('%o', $old), fstat => sprintf('%o', $fstat), after => sprintf('%o', $n[2] & 07777), content => slurp($name) };
  }
}
put('h1', "old\n");
link('h1', 'h2') or die "link $!";
my @h = lstat('h1');
out({ modes => \%res, links => $h[3] });
`;

const L5 = String.raw`
my @groups = split ' ', $);
my $egid = shift @groups;
my %mine = map { $_ => 1 } ($egid, @groups);
my ($second) = grep { $_ != $egid } @groups;
my ($foreign) = grep { !$mine{$_} } (0, 65534);
my ($fh, $err) = tmpfile('.');
die "tmpfile $err" unless defined $fh;
my @st = stat($fh);
my %res = (uid => $st[4], euid => $> + 0, gid => $st[5], egid => $egid + 0);
if (defined $second) {
  my $n = chown(-1, $second, $fh);
  $res{ownGroup} = { gid => $second + 0, changed => $n, errno => $n ? 0 : $! + 0, gidAfter => (stat($fh))[5] };
  mkdir('sg', 0777) or die "mkdir $!";
  chown(-1, $second, 'sg') or die "chown sg $!";
  chmod(02775, 'sg') or die "chmod sg $!";
  my ($f2, $e2) = tmpfile('sg');
  die "tmpfile sg $e2" unless defined $f2;
  $res{setgidFolder} = { folderGid => (stat('sg'))[5], folderMode => sprintf('%o', (stat('sg'))[2] & 07777), fileGid => (stat($f2))[5] };
}
if (defined $foreign) {
  my $n = chown(-1, $foreign, $fh);
  $res{foreignGroup} = { gid => $foreign + 0, changed => $n, errno => $n ? 0 : $! + 0 };
}
out(\%res);
`;

// perlfunc `syscall` passes a string as a pointer and refuses a read-only value, so each string is a variable.
const L6 = String.raw`
put('x.txt', "x\n");
my ($path, $attr, $value) = ('x.txt', 'user.test', 'v');
my $set = $NR{setxattr} ? syscall($NR{setxattr}, $path, $attr, $value, 1, 0) : -1;
my $set_err = $set == 0 ? 0 : $! + 0;
my $acl = -x '/usr/bin/setfacl' ? 1 : 0;
my $acl_exit = $acl ? system('/usr/bin/setfacl', '-m', "u:$<:r--", 'x.txt') : -1;
my $buf = "\0" x 65536;
my $n = $NR{llistxattr} ? syscall($NR{llistxattr}, $path, $buf, length($buf)) : -1;
my $list_err = $n >= 0 ? 0 : $! + 0;
my @names = $n > 0 ? grep { length } split(/\0/, substr($buf, 0, $n)) : ();
out({ setxattr => { nr => $NR{setxattr}, result => $set, errno => $set_err }, llistxattr => { nr => $NR{llistxattr}, errno => $list_err }, acl => $acl, aclExit => $acl_exit, names => [sort @names] });
`;

const L7 = String.raw`
mkdir('p', 0777) or die "mkdir $!";
mkdir('p/q', 0777) or die "mkdir $!";
out({ umask => sprintf('%04o', umask), p => sprintf('%o', (stat('p'))[2] & 07777), q => sprintf('%o', (stat('p/q'))[2] & 07777) });
`;

// One Perl process that stops at `stage`, then a `kill -9` of its distro PID, then the folder listing.
async function killAt(w: WslHost, dir: string, stage: string): Promise<{ names: string[]; target: string | null }> {
  const proc = Bun.spawn([WSL_EXE, "--distribution", w.distro, "--cd", owned(w, dir), "--exec", w.probe.paths.perl!, "-e", PRELUDE + L3, "--", stage], { env: WSL_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + STAGE_MS;
    let text = "";
    let pid: string | null = null;
    while (pid === null) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no STAGE ${stage} line within ${STAGE_MS} ms: ${JSON.stringify(text)}`);
      const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
      if (chunk === null) continue;
      if (chunk.done) throw new Error(`perl ended before STAGE ${stage}: ${JSON.stringify(text)} ${await new Response(proc.stderr).text()}`);
      text += Buffer.from(chunk.value).toString("utf8");
      pid = new RegExp(`^STAGE ${stage} (\\d+)$`, "m").exec(text)?.[1] ?? null;
    }
    reader.releaseLock();
    inDistro(w.distro, ["/usr/bin/kill", "-9", pid]);
    const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(STAGE_MS).then(() => false)]);
    if (!ended) throw new Error(`wsl.exe did not end within ${STAGE_MS} ms after kill -9 ${pid}`);
  } finally {
    // The client process of this test only. A clean end makes this a no-op.
    proc.kill();
  }
  const listed = sh(w, "find \"$1\" -mindepth 1 -maxdepth 1 -printf '%f\\0'", [owned(w, dir)]);
  const target = sh(w, '[ -e "$1/target" ] || exit 3; cat -- "$1/target"', [owned(w, dir)], { allowExit: [0, 3] });
  return { names: Buffer.from(listed.bytes).toString("utf8").split(NUL).filter((n) => n !== "").sort(), target: target.exitCode === 3 ? null : target.stdout };
}

let versionText: string | undefined;
function versionOf(w: WslHost): string {
  versionText ??= `git=${revertGitVersion(hostOf(w))}@${w.distro}`;
  return versionText;
}
const print = (w: WslHost, observations: Observation[]) => {
  expect(observations.length).toBeGreaterThan(0);
  for (const o of observations) console.log(observationLine(TASK, o, versionOf(w)));
};

wslTest("distro versions", NEEDS, (w) => {
  const release = inDistro(w.distro, ["/usr/bin/cat", "/etc/os-release"]);
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(release)?.[1] ?? null;
  const kernel = inDistro(w.distro, ["/usr/bin/uname", "-r"]).trim();
  const perlVersion = perl(w, folder(w, "versions"), "out({ perl => \"$]\" });").perl;
  print(w, [obs("versions", "record", { distro: w.distro, pretty, kernel, perl: perlVersion, git: revertGitVersion(hostOf(w)) }, true)]);
}, FACT_MS);

wslTest("L1 O_TMPFILE from Perl in the owned ext4 folder", NEEDS, (w) => {
  const r = perl(w, folder(w, "l1"), L1);
  // include/uapi/asm-generic/fcntl.h: `__O_TMPFILE 020000000` with `O_DIRECTORY 0200000`.
  print(w, [obs("L1.o-tmpfile", { tmpfile: "20200000", source: "Fcntl", open: 1, errno: 0, names: [] }, { tmpfile: r.tmpfile, source: r.source, open: r.open, errno: r.errno, names: r.names })]);
}, FACT_MS);

wslTest("L2 linkat through /proc/self/fd names the unnamed file", NEEDS, (w) => {
  const r = perl(w, folder(w, "l2"), L2);
  print(w, [obs("L2.linkat", { errno: 0, content: "linked\n", links: 1 }, { errno: r.errno, content: r.content, links: r.links }), obs("L2.syscall", "record", { nr: r.nr, source: r.source, arch: r.arch, uid: r.uid, fileUid: r.fileUid }, true)]);
}, FACT_MS);

wslTest("L3 kill -9 after the O_TMPFILE create, after linkat, and after rename", NEEDS, async (w) => {
  const observations: Observation[] = [];
  const expected: Record<string, { names: string[]; target: string }> = {
    tmpfile: { names: ["target"], target: "old\n" },
    linkat: { names: [".arbareto-probe.tmp", "target"], target: "old\n" },
    rename: { names: ["target"], target: "new\n" },
  };
  for (const stage of ["tmpfile", "linkat", "rename"]) {
    const dir = folder(w, `l3-${stage}`);
    sh(w, 'printf "old\\n" > "$1/target"', [owned(w, dir)]);
    observations.push(obs(`L3.kill-after-${stage}`, expected[stage], await killAt(w, dir, stage)));
  }
  print(w, observations);
}, FACT_MS);

wslTest("L4 mode bits after fchmod and rename; a second link", NEEDS, (w) => {
  const r = perl(w, folder(w, "l4"), L4);
  const modes = Object.entries(r.modes as Record<string, { before: string; fstat?: string; after: string; content: string }>);
  const observations = modes.filter(([name]) => !name.startsWith("chown-")).map(([name, m]) => obs(`L4.mode-${name}`, { after: m.before, content: "new\n" }, { after: m.after, content: m.content }));
  // chown(2) "NOTES": the chown after the mode copy clears the set-user-ID and set-group-ID bits. The fstat compare before linkat sees it.
  const cleared = (mode: string) => (Number.parseInt(mode, 8) & ~0o6000).toString(8);
  for (const [name, m] of modes.filter(([n]) => n.startsWith("chown-"))) {
    const kept = name.startsWith("chown-first");
    observations.push(obs(`L4.${name}`, { fstat: kept ? m.before : cleared(m.before), after: kept ? m.before : cleared(m.before), content: "new\n" }, { fstat: m.fstat, after: m.after, content: m.content }));
  }
  observations.push(obs("L4.second-link-count", 2, r.links));
  print(w, observations);
}, FACT_MS);

wslTest("L5 the owner and group of the O_TMPFILE file; fchown of the group", NEEDS, (w) => {
  const r = perl(w, folder(w, "l5"), L5);
  const observations = [obs("L5.effective-ids", { uid: r.euid, gid: r.egid }, { uid: r.uid, gid: r.gid })];
  if (r.ownGroup === undefined) {
    console.log(`SKIP ${TASK} L5 own group and setgid folder: missing capability second-group (unverified)`);
  } else {
    observations.push(obs("L5.fchown-own-group", { changed: 1, errno: 0, gidAfter: r.ownGroup.gid }, { changed: r.ownGroup.changed, errno: r.ownGroup.errno, gidAfter: r.ownGroup.gidAfter }));
    observations.push(obs("L5.setgid-folder-gid", r.setgidFolder.folderGid, r.setgidFolder.fileGid));
  }
  // asm-generic/errno-base.h: EPERM is 1.
  if (r.foreignGroup === undefined) console.log(`SKIP ${TASK} L5 foreign group: missing capability foreign-group (unverified)`);
  else observations.push(obs("L5.fchown-foreign-group", { changed: 0, errno: 1 }, { changed: r.foreignGroup.changed, errno: r.foreignGroup.errno }));
  print(w, observations);
}, FACT_MS);

wslTest("L6 llistxattr lists user.test (and the ACL name with acl-tools)", NEEDS, (w) => {
  const r = perl(w, folder(w, "l6"), L6);
  const observations = [obs("L6.syscalls", "record", { setxattr: r.setxattr, llistxattr: r.llistxattr }, true)];
  if (r.acl === 1) {
    observations.push(obs("L6.llistxattr", ["system.posix_acl_access", "user.test"], r.names));
  } else {
    console.log(`SKIP ${TASK} L6 system.posix_acl_access: missing capability acl-tools (unverified)`);
    observations.push(obs("L6.llistxattr", ["user.test"], r.names));
  }
  print(w, observations);
}, FACT_MS);

wslTest("L7 mkdir of a missing folder chain against git restore on a copy", NEEDS, (w) => {
  const x = hostOf(w);
  const repo = `${x.git.root}/l7`;
  gitRun(x.git, x.git.root, ["init", "-q", "-b", "main", repo]);
  x.git.write(`${repo}/a/b/c.txt`, "c\n");
  gitRun(x.git, repo, ["add", "--", "a/b/c.txt"]);
  gitRun(x.git, repo, ["commit", "-q", "--no-verify", "-m", "c"]);
  sh(w, 'rm -rf -- "$1/a"', [owned(w, repo)]);
  const restored = x.git.run(repo, ["--no-lazy-fetch", "restore", "--", "a/b/c.txt"]);
  const modes = sh(w, 'stat --format="%a" -- "$1/a" "$1/a/b"', [owned(w, repo)]).stdout.trim().split("\n");
  const r = perl(w, folder(w, "l7"), L7);
  const expected = ((0o777 & ~Number.parseInt(r.umask, 8)) >>> 0).toString(8);
  print(w, [obs("L7.mkdir-mode", { restore: 0, git: [expected, expected], perl: [expected, expected] }, { restore: restored.exitCode, git: modes, perl: [r.p, r.q] }), obs("L7.umask", "record", r.umask, true)]);
}, FACT_MS);

// G9 and G10 inside the distro (tasks.md T004). The distro Git needs `git-lfs` for the LFS case.
const host = wslHost();
const lfs = host?.probe.paths.git ? wslExec(["--distribution", host.distro, "--cd", "/", "--exec", host.probe.paths.git, "lfs", "version"]).exitCode === 0 : false;
for (const fact of REVERT_FACTS.filter((f) => f.id.startsWith("G9"))) {
  const name = `${fact.id}: ${fact.title} (distro)`;
  if (fact.needs === "git-lfs" && !lfs) {
    console.log(`SKIP git-lfs: ${name}`);
    test.skip(`${name} (SKIP: git-lfs)`, () => {});
    continue;
  }
  wslTest(name, NEEDS, (w) => {
    const observations = fact.run(hostOf(w));
    expect(observations.length).toBeGreaterThan(0);
    for (const line of factLines(TASK, fact, observations, versionOf(w))) console.log(line);
  }, FACT_MS);
}

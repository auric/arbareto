# PuTTY tests in Windows Sandbox

`putty-tests.wsb` and `putty-tests-prepare.ps1` run the PuTTY cases of feature 003 (T012, T080) in Windows Sandbox. Cases that start plink, Pageant, or PuTTYgen run only there. The host PuTTY registry key, Pageant, `~/.ssh`, and `known_hosts` stay untouched.

## Prerequisites

- Enable the Windows Sandbox feature once. This needs administrator rights and a reboot.
- Run `bun install` in the checkout. The Sandbox uses its `node_modules`.
- Get PuTTY 0.75 or later as a folder with `plink.exe`, `pageant.exe`, and `puttygen.exe`.
- Get a Bun binary with the file name `bun.exe`, and a Git for Windows installer.
- Keep the Bun binary and the Git installer in folders without private files. The Sandbox gets read access to each folder.

## Steps

1. On the host, run `scripts\windows\putty-tests-prepare.ps1 -PuttyDir <folder> -BunExe <bun.exe> -GitInstaller <installer.exe>`. Add `-Checkout <folder>` for another checkout. Add `-Stage <folder>` to change the default `%USERPROFILE%\arbareto-sandbox\putty`.
2. The script refuses a missing path and names it. Else it writes `<Stage>\putty-tests.wsb`.
3. Open `<Stage>\putty-tests.wsb`. Do not open `scripts\windows\putty-tests.wsb`; it is a template with `{{NAME}}` placeholders.
4. In the Sandbox, the logon command installs Git and opens a console in `C:\arbareto\checkout`.
5. Run the command that the console prints. The tests start the T011 SSH server on the Sandbox 127.0.0.1.
6. Collect the logs from `<Stage>\out`. Close the Sandbox to discard its state.

## Sandbox layout

| Sandbox folder | Host folder | Access |
|---|---|---|
| `C:\arbareto\checkout` | the checkout | read-only |
| `C:\arbareto\putty` | `-PuttyDir` | read-only |
| `C:\arbareto\bun` | the folder of `-BunExe` | read-only |
| `C:\arbareto\git-installer` | the folder of `-GitInstaller` | read-only |
| `C:\arbareto\out` | `<Stage>\out` | read and write |

The console sets `ARBARETO_TEST_SANDBOX=1`, `ARBARETO_TEST_PUTTY_DIR=C:\arbareto\putty`, and `ARBARETO_TEST_GIT` to the installed `git.exe`. Networking is off.

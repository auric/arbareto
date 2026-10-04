# Spec Kit scripts without PowerShell

- The `speckit-*` skills call `.specify/scripts/powershell/<name>.ps1`. Do not edit the skills or the scripts.
- First, run `command -v pwsh`. If `pwsh` is available, use the PowerShell call from the skill.
- If `pwsh` is not available, run `bash .specify/scripts/bash/<name>.sh` from the repository root. Map the flags with the table below.

| Skill | PowerShell call | Bash call |
|---|---|---|
| analyze, converge | `check-prerequisites.ps1 -Json -RequireSpec -RequireTasks -IncludeTasks` | `check-prerequisites.sh --json --require-spec --require-tasks --include-tasks` |
| implement, taskstoissues | `check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` | `check-prerequisites.sh --json --require-tasks --include-tasks` |
| clarify | `check-prerequisites.ps1 -Json -PathsOnly` | `check-prerequisites.sh --json --paths-only` |
| checklist | `check-prerequisites.ps1 -Json -Template checklist-template` | `check-prerequisites.sh --json --template checklist-template` |
| constitution | `resolve-template.ps1 constitution-template -Json` | `resolve-template.sh constitution-template --json` |
| plan | `setup-plan.ps1 -Json` | `setup-plan.sh --json` |
| tasks | `setup-tasks.ps1 -Json` | `setup-tasks.sh --json` |

- These mappings match Spec Kit v1.0.12. Re-check the table after a Spec Kit upgrade.
- Other flags use the same rule: `-FlagName` becomes `--flag-name`.
- The scripts find the feature through `SPECIFY_FEATURE_DIRECTORY` first, then `.specify/feature.json`.
- Git ignores `.specify/feature.json`, so a fresh clone does not have it.
- If the file is absent, create it with `{"feature_directory": "specs/001-desktop-qualification"}`. As an alternative, set `SPECIFY_FEATURE_DIRECTORY=specs/001-desktop-qualification`.
- The scripts write `SPECIFY_FEATURE_DIRECTORY` into `feature.json`. Set `SPECIFY_FEATURE_NO_PERSIST=1` to prevent this write.

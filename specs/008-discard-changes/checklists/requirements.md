# Specification Quality Checklist: Discard (Revert) Changes

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-27
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [ ] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
- The spec has no [NEEDS CLARIFICATION] marker. The user answered the four open product choices on 2026-10-27, each with the recommended option. Clarifications records them.
- "No implementation details" is not met on purpose. FR-031 names the Git commands that must not write working files, because the user made this a safety requirement. FR-015 and FR-038 name the Git facts that decide a refusal, because the exact fact is the requirement. File and code references sit in "Design notes for planning".
- "Written for non-technical stakeholders" is not met. The readers are developers. The spec names the index, Git attributes, line-ending conversion, hard links, and POSIX mode bits, because these facts are the requirement.
- "Technology-agnostic success criteria" is not met. SC-001, SC-002, and SC-008 use Git's own commands on a copy as the oracle, and SC-007 and SC-008 name WSL. Constitution IV and VI require these oracles and the packaged evidence.
- SC-007 proposes the time and memory budgets. The plan confirms or changes them before the measurement, as constitution VII requires.
- The batch 0 probes ran on 2026-10-27 (research R15). They decided the R8 and R9 facts (FR-035, FR-036), G9 (FR-019, FR-028), and G10. These points stay unverified: the owner of a file that an elevated process created (W2), the ACL case of L6, the LFS fixture of G9 and G10 in the distro, and the integrity-stream attribute (ReFS).
- The `speckit-checklist` step ran after the plan, in the CLAUDE.md order. It wrote `checklists/safety.md`.
- Re-check after the clarify answers, the plan, and the checklist pass of 2026-10-27:
  - Testable: FR-011 states the 60 s review lifetime and its text. FR-015 states one exact ending rule, and the proof decides. FR-025 states no size limit for whole files and the 001 comparison bounds for lines (design change of 2026-10-27, review of 2026-10-30). FR-040 bounds the listed files. FR-038 lists the new file-fact reasons and the index lock refusal.
  - Consistent: FR-004 and the Clarifications state why no hook runs, and plan note N-1 checks it against constitution I. FR-018 limits marks to one list. FR-043 adds the group rule of plan D9. The refusal sets of FR-038, data-model §7, and contract Δ9 match.
  - Edge cases: the expired review, R in the History diff, the index lock for every revert, and the `.gitattributes` file itself are present.
  - The items keep their state. The three unmet items stay unmet for the reasons above.

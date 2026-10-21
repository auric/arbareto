# Specification Quality Checklist: History Inspection and Commit View File Actions

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-21
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Implementation details sit only in the appendix "Design notes for planning", as the dispatch asked. The FRs name a Git fact only where the fact is the requirement, such as the two-tree comparison, Git's numstat binary fact, Git's blame markers, and `blame.ignoreRevsFile`. This follows the 004 spec style.
- SC-001, SC-002, SC-006, and SC-007 state times and memory on a packaged build, as constitution principle VII requires. They name no technology.
- The ignore preview method comes from the investigator report of 2026-10-21. FR-038 and FR-039 require an exact preview or a typed "Preview not available" state, so no marker is needed.
- First validation passed in one iteration. The clarify scan of 2026-10-21 then found gaps, so "Requirements are testable and unambiguous" was not true at that time.
- Re-check after the clarify pass of 2026-10-21 (Q1 to Q6, the Open submodule entry in the Commit view, facts F1 to F6):
  - Testable: FR-007 has times from SC-001. FR-055 defines the rank steps. FR-056 holds the hunk-header rule. FR-038 defines the tracked count. FR-015 sorts submodule and nested-repository rows as folders. FR-026 has the singular form. FR-021 has visible text. FR-065 defines "branch list". FR-066 defines the remote-row card. FR-034 defines an existing line.
  - Consistent: FR-003 puts the index-loading reads behind the 001 read gate. FR-028, FR-060, FR-063, FR-064, FR-051, and the WSL crossing text match Git, the design, and the answers.
  - Edge cases: the path-based delete limits, the 1 MiB digest limit, the nested-chain recent entries, the preview cleanup, Blame before without a previous commit, and Blame on a deleted row are present.
  - Honest limits: FR-030, FR-031, and SC-003 state the known delete gaps and claim no more. FR-003 and FR-051 leave two facts for the plan to verify: the "Blame before" index load and the recent entry of a submodule open. These are plan checks, not open requirements.
  - Content quality: FR-003, FR-056, and FR-059 name Git facts (`core.fsmonitor`, hunk headers, `blame.ignoreRevsFile`) because the fact is the requirement. The items stay checked on that basis, as in the 004 spec.
  - Every FR and Clarification sentence has at most 20 words, with quoted UI text counted as one word.
- Re-check after the plan review of 2026-10-21 (FR-031, FR-046, the new Clarification on Save, the 001 FR-016 entry, three Edge Cases, and one SC-003 sentence):
  - Testable: FR-046 states the operation and conflict states in which Save runs, and Q23 tests Save during a merge with conflicts. FR-031 names both path-based windows of the Recycle Bin call. The long-path Edge Case gives the 260-character bound.
  - Consistent: FR-046, the Clarification, the 001 FR-016 entry, plan D10, and contract Δ3 agree. Delete stays blocked by FR-033. The FR-031 limit, the Edge Cases, SC-003, and the contract gaps name the same windows.
  - Honest limits: FR-031 and SC-003 claim no fixture for a change inside a path-based window.
  - Open point outside the spec text: plan O-9. The Git 2.56 source keeps the `blame.ignoreRevsFile` values sorted, so an empty value may reset nothing. FR-059 follows the Git doc. F7 decides, and a FR-059 change then needs user approval. FR-059 stays testable as written.
  - Every changed FR and Clarification sentence has at most 20 words. The items stay checked.

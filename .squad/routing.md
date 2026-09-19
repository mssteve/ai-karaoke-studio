# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture & integration | Neo | IPC contracts, private protocols, release gates |
| Electron & React UI | Trinity | Library, player, dialogs, interaction states |
| Audio & local AI | Morpheus | FFmpeg, Demucs, Whisper, stems, timed lyrics |
| Code review & testing | Tank | Feature matrix, screenshots, automation, regressions |
| Windows packaging | Switch | NSIS, APPX, icons, Store compliance |
| Approved user-facing/shipped change | Switch after reviewer approval | Mandatory full NSIS/APPX release and packaged QA |
| Playback reliability | Cypher | Media event races, near-end state, deterministic transport |
| Media test integrity | Apoc | Terminal-state contracts, probes, repeatable stress evidence |
| Scope & priorities | Neo | What to build next, trade-offs, decisions |
| Session logging | Scribe | Automatic — never needs routing |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Lead |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, the **Lead** triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the "inbox" — untriaged issues waiting for Lead review.

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn the tester to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. The Lead handles all `squad` (base label) triage.
8. **Automatic release handoff** — independently approved user-facing or shipped-runtime changes automatically route to Switch; keep the overall request open through fresh NSIS/APPX packaging and independent packaged review.
9. **Read the canonical release skill** — Neo, Switch, Tank, and implementation/reliability agents must read `.squad\skills\full-windows-store-release\SKILL.md` before release planning, packaging, packaged QA, or declaring distributable work complete. Build-only validation is not release completion.

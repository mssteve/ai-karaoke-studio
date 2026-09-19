---
last_updated: 2026-09-18T00:22:39.219Z
---

# Team Wisdom

Reusable patterns and heuristics learned through work. NOT transcripts — each entry is a distilled, actionable insight.

## Patterns

<!-- Append entries below. Format: **Pattern:** description. **Context:** when it applies. -->

**Pattern:** Bind replacement seeks and autoplay to the exact media source generation, apply position at `canplay`, and wait for seek settlement before playback. **Context:** Media source replacement, rapid mode switching, and FIFO auto-advance.

**Pattern:** Terminal playback acceptance must use actual duration and require `ended`, paused media, and cleared playback intent; a playable near-end snapshot is not terminal proof. **Context:** Short and long media fixtures with asynchronous browser events.

**Pattern:** Keep queue entry identity separate from song identity and advance only on genuine natural `ended`. **Context:** Duplicate-safe persistent FIFO playlists and exactly-once auto-advance.

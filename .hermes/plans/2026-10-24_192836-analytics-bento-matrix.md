# Analytics Bento Matrix UI (#197) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Transform the endless-scrolling Analytics page into an executive Bento Matrix with glanceable modular tiles and modal deep-dives for models, sessions, daily values, and tools.

**Architecture:** Refactor `web/src/pages/AnalyticsPage.vue` into an executive 12-column Bento Grid that fits on desktop without vertical scrolling. High-level telemetry lives in 5 focused modular cards (Daily Activity SVG chart, Token Composition & Spend, Models Leaderboard, Tool Operations, and Active Sessions), with deep-dive detail dialogs (Daily Values, All Models Catalog, Sessions Explorer, All Tools, and Session Inspector) triggered on demand using accessible dialog modals.

**Tech Stack:** Vue 3 (SFC `<script setup lang="ts">`), Tailwind CSS v4, Lucide icons (`@lucide/vue`), TypeScript 5, Vite, Reka UI Dialog components.

---

### Task 1: Create Isolated Worktree & Branch

**Objective:** Set up an isolated git worktree for issue #197 so `main` remains untouched during development.

**Files:**
- Worktree location: `/home/m57/Projects/.luna-worktrees/luna-pi-197-analytics-bento`
- Branch: `feat/197-analytics-bento`

**Step 1: Verify worktree status**
Run: `cd /home/m57/Projects/.luna-worktrees/luna-pi-197-analytics-bento && git status`
Expected: `On branch feat/197-analytics-bento`, clean working tree.

**Step 2: Verify build and typecheck in worktree**
Run: `cd /home/m57/Projects/.luna-worktrees/luna-pi-197-analytics-bento && pnpm run typecheck:web`
Expected: Exit code 0.

---

### Task 2: Extract Reusable Analytics Deep Dive Dialog Components

**Objective:** Create modular modal components for deep-dive inspections to keep `AnalyticsPage.vue` clean and DRY.

**Files:**
- Create: `web/src/pages/analytics/DailyValuesDialog.vue`
- Create: `web/src/pages/analytics/ModelsCatalogDialog.vue`
- Create: `web/src/pages/analytics/SessionsConsoleDialog.vue`
- Create: `web/src/pages/analytics/ToolsDetailDialog.vue`
- Create: `web/src/pages/analytics/SessionInspectDialog.vue`

**Step 1: Implement DailyValuesDialog.vue**
Render a scrollable UTC table of the last 30 active days showing responses, uncached input, output, cache read, and cache write tokens with tabular formatting.

**Step 2: Implement ModelsCatalogDialog.vue**
Render the full 21-model catalog table including token usage, input/output, cache read/write, hit rate, USD cost, responses, and current rates per 1M tokens.

**Step 3: Implement SessionsConsoleDialog.vue**
Port the existing full sessions table into a paginated dialog with search, status filters (ready, running, finished, limit_reached, needs_input), sort controls, and row selection.

**Step 4: Implement ToolsDetailDialog.vue**
Render all tracked tools with call counts, error counts, error rates (%), token usage, and tool-reported cost.

**Step 5: Implement SessionInspectDialog.vue**
Provide a targeted inspector modal displaying turn counts (user/assistant), tokens per turn, execution duration, subagent count, target worker, and project metadata.

**Step 6: Verify Typecheck**
Run: `pnpm run typecheck:web`
Expected: Exit code 0.

**Step 7: Commit**
```bash
git add web/src/pages/analytics/
git commit -m "feat(analytics): add deep-dive dialog components"
```

---

### Task 3: Build the Bento Matrix Modular Grid in AnalyticsPage.vue

**Objective:** Replace the endless vertical stack in `AnalyticsPage.vue` with the 12-column responsive Bento Grid layout.

**Files:**
- Modify: `web/src/pages/AnalyticsPage.vue`

**Step 1: Top KPI Row (4 Glanceable Cards)**
- Total Tokens (with compact formatting and observed response count)
- Recorded Cost in USD (with estimate note)
- Cache Hit Rate (% and cache read ratio)
- Retained Sessions count (and model count)

**Step 2: Bento Grid Tile 1 (Span 8 cols) - Daily Token Flow**
- Interactive SVG timeline showing stacked input, output, cache read, cache write.
- Floating hover tooltip showing daily token counts and responses.
- Header button: "Daily Values Table" opening `DailyValuesDialog`.

**Step 3: Bento Grid Tile 2 (Span 4 cols) - Composition & Spend**
- 4-segment visual gauge bar (Input, Output, Cache Read, Cache Write).
- Compact token breakdown with reasoning and 1h cache writes.
- Total recorded spend highlight.

**Step 4: Bento Grid Tile 3 (Span 4 cols) - Top Models Leaderboard**
- Top 5 models sorted by token consumption.
- Mini progress bars indicating relative token proportion.
- Header button: "View All (21) →" opening `ModelsCatalogDialog`.

**Step 5: Bento Grid Tile 4 (Span 4 cols) - Tool Health & Operations**
- Top 5 tools by invocation frequency with error indicators.
- Summary chip row for file operations: Reads, Writes, Edits, Bash execs.
- Header button: "View All Tools →" opening `ToolsDetailDialog`.

**Step 6: Bento Grid Tile 5 (Span 4 cols) - Active & Recent Sessions**
- Top 5 active/recent sessions with status chips and last activity times.
- Click on any session row opens `SessionInspectDialog`.
- Header button: "Open Console (488) →" opening `SessionsConsoleDialog`.

**Step 7: Bento Grid Tile 6 (Span 12 cols) - System Footprint & Projects**
- Compact footer strip displaying project distribution (tokens/spend per project), worker distribution, and system reliability stop reasons.

**Step 8: Verify build & typecheck**
Run: `pnpm run typecheck:web && pnpm run build:web`
Expected: Both exit code 0.

**Step 9: Commit**
```bash
git add web/src/pages/AnalyticsPage.vue
git commit -m "feat(analytics): implement executive bento matrix layout (#197)"
```

---

### Task 4: Responsive Layout & Mobile Viewport Polish

**Objective:** Ensure the Bento grid collapses gracefully to single-column on mobile viewports (<768px) and double-column on tablet (<1100px) with 0 horizontal scroll.

**Files:**
- Modify: `web/src/pages/AnalyticsPage.vue`
- Modify: `web/src/pages/analytics/*.vue`

**Step 1: Test mobile breakpoints**
- Under 1000px: 12-column spans convert to full width (`span 12`).
- Touch targets remain min 44×44px.
- Tooltips work on tap/click on touch devices.

**Step 2: Verify zero UI emojis and STE conformance**
Ensure only Lucide SVG icons are used and text labels follow concise, state-honest terminology.

**Step 3: Commit**
```bash
git add web/src/pages/AnalyticsPage.vue web/src/pages/analytics/
git commit -m "fix(analytics): mobile responsiveness and accessibility for bento matrix"
```

---

### Task 5: End-to-End Verification with Live Luna Telemetry

**Objective:** Verify that the built application runs cleanly against live Luna daemon telemetry and all modal deep-dives function properly.

**Step 1: Build the production bundle**
Run: `pnpm run build:web`
Expected: Build passes with no warnings/errors.

**Step 2: Headless Playwright / Browser Verification**
- Navigate to the Analytics tab.
- Verify all 4 KPIs render live data.
- Verify the 5 Bento tiles render without layout shifts.
- Test opening and closing all 5 dialog modals (`DailyValues`, `ModelsCatalog`, `SessionsConsole`, `ToolsDetail`, `SessionInspect`).
- Verify filtering by model correctly slices the Bento tiles.

**Step 3: Commit and Push to Branch**
```bash
git push -u origin feat/197-analytics-bento
```

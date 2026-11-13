# Luna Web UI Design System (`DESIGN.md`)

## Scope and Sources of Truth

This document defines visual, layout, interaction, and accessibility requirements for new or changed UI in `luna-agent` (`web/`). It complements:

- [`AGENTS.md`](AGENTS.md): operational rules, runtime contracts, and verification commands.
- [`CONFIGURATION.md`](CONFIGURATION.md): user settings, tool contracts, and HTTP API reference.

`web/src/style.css` and the Vue 3 components under `web/src/` are authoritative for implemented CSS custom properties and DOM structure. Flag conflicts between requirements and existing code instead of silently redesigning unrelated views.

---

## Design Principles

- **Tone:** Technical, focused, high-density, utilitarian, and dark-first (`color-scheme: dark`).
- **State-Honest UI:** Every chip, dot, badge, meter, and toggle must reflect real backend state. Avoid decorative chrome, fake controls, or speculative placeholders.
- **Flat Surface Hierarchy:** Distinguish layers using subtle surface luminance steps (`--background` → `--sidebar` → `--card` → `--secondary`) and `1px solid var(--border)` hairlines, never multi-color gradients on chat canvases or message bubbles.
- **Direct Discoverability:** Prefer dropdowns, popovers, and inline disclosure cards (`<details class="card">`) over blind cycle buttons. Anchor primary actions in top headers or fixed composer docks; do not use Floating Action Buttons (FABs).

---

## Token Source Map (`web/src/style.css`)

Always reference semantic CSS custom properties (or their Tailwind v4 `@theme inline` utility equivalents such as `bg-background`, `bg-card`, `text-muted-foreground`, `border-border`) rather than hardcoding raw hex values in component templates.

### Core Surface & Text Tokens

| Token | Value | Alias | Role |
| --- | --- | --- | --- |
| `--background` | `#121212` | `--bg` | Main canvas and full-bleed chat transcript background |
| `--foreground` | `#ececec` | `--fg` | Primary body and heading text |
| `--sidebar` | `#171717` | `--side` | Left navigation rail and code block (`pre.code`) background |
| `--sidebar-foreground` | `#cfcfcf` | — | Default sidebar text |
| `--sidebar-accent` | `#242424` | — | Sidebar item hover/active surface |
| `--sidebar-border` | `#262626` | — | Sidebar structural dividers |
| `--card` | `#1c1c1c` | `--surface` | Cards, composer box, tool call rows, settings groups |
| `--popover` | `#1c1c1c` | — | Floating menus (`#model-picker`, `#mention-menu`, `#command-menu`, `#statusbar` popover) |
| `--secondary` | `#242424` | `--raised` | User message bubble fill, inline `<code>`, secondary buttons |
| `--accent` | `#242424` | `--hover` | Interactive hover surface |
| `--muted-foreground` | `#a0a0a0` | `--dim` | Secondary labels, summaries, metadata |
| `--faint` | `#808080` | — | Timestamps, line numbers, subtle section headers |
| `--border` | `#2c2c2c` | `--line` | Default `1px` structural and card borders |
| `--input` | `#333333` | `--line-strong` | Form control and composer borders |

### Accent & Semantic Status Tokens

| Token / Selector | Value | Role |
| --- | --- | --- |
| `--primary` (`--acc`) | `#990000` | Accent fill: send button, solid primary controls, checked inputs. Too dark for text on `--background` (2.1:1); use `--primary-text` |
| `--primary-text` | `#e86060` | Accent as text/icon on dark surfaces (links, active nav/session items, pins); 5:1 on `--background` |
| `--primary-foreground` (`--acc-ink`) | `#ffffff` | Text/icon color on solid `--primary` controls |
| `--acc-strong` | `#b30000` | Primary button hover state |
| `--acc-soft` | `rgb(153 0 0 / 0.2)` | Soft tint fill for selected rows, active nav items, and checked options |
| `--ring` | `#e86060` | Keyboard `:focus-visible` outline (`2px solid var(--ring)`) |
| `--ok` | `#8fd3a5` | Diff additions, healthy context meter, completed task icons |
| `--warn` | `#e6c27a` | Amber context meter (`data-level="amber"`), warning indicators |
| `--destructive` (`--err`) | `#f87171` | Errors, failed tool calls, diff deletions, danger menu items |
| `--err-soft` | `rgb(255 155 149 / 0.1)` | Error message banner background (`.msg.err`) |

### Session, Board, and Reasoning Status Palettes

- **Session state (`[data-status]` on `.session-state`):**
  - `running`: `#60a5fa`
  - `finished`: `#4ade80`
  - `needs_approval`: `#fbbf24`
  - `needs_input`: `#c084fc`
  - `limit_reached`: `#fb923c`
  - `failed`: `var(--destructive)` (`#f87171`)
- **Board status dots (`.mention-status-dot[data-status]`):**
  - `todo`: `#7398cb`, `backlog`: `#8c95a5`, `review`: `#a08bcc`, `in_progress`: `#d6a453`, `done`: `#6b9e84`
- **Board priority dots & pills (`[data-priority]`):**
  - `urgent`: `#f18f98` (pill `#ffa5ad` on `#3c252c`)
  - `high`: `#ebbf77` (pill `#f0c783` on `#352d20`)
  - `medium`: `#8faee0` (pill `#a8c4f0` on `#243145`)
  - `low`: `#9da8b5` (pill `#b2bdca` on `#292f37`)
- **Reasoning gauge (`ReasoningControl.vue`):**
  - 7 stops (`off` → `max`): `#9ba1a6`, `#7dd3fc`, `#5eead4`, `#86d3a0`, `#e6c27a`, `#f4a571`, `#c4a1f5`.

### Typography, Radii, and Dimensions

- **UI Font:** System sans-serif stack (`system-ui, -apple-system, ...`) at `14px` base size.
- **Monospace Font (`--mono`):** `ui-monospace, monospace` for tool names, diffs, terminal output, code blocks, slash commands, and card IDs. Use `font-variant-numeric: tabular-nums` on timestamps and usage percentages.
- **Corner Radii:**
  - All UI surface and control corners use `--radius: 1px`, including Tailwind radius utilities and legacy `--r` aliases.
  - Circular status indicators, spinners, switch thumbs, and scrollbar thumbs stay circular. Flush nested content keeps zero radius.
  - Active session rows keep their text/status colors and use a subtle red-tinted background across the whole row.
- **Control Sizing:**
  - Standard control height (`--control`): `36px` (`#send`, `#stop`, `#think`, `.side-item`).
  - Icon button (`.icon-button`): `32px × 32px` (`28px × 28px` inside dense message footers or activity rows; `32px × 32px` on mobile footers).
  - Top header (`#top`): `56px` (`h-14`) fixed height with `1px solid var(--border)` bottom border.

---

## UI Surfaces & Component Contracts

### 1. Application Shell & Sidebar (`App.vue`, `Sidebar.vue`)

- **Fixed Viewport Containment (`#app`):**
  `#app` is `position: fixed` with `height: var(--viewport-height, 100dvh)` and `top: var(--viewport-top, 0px)`, updated dynamically by `trackViewport()` (`web/src/lib/viewport.ts`) when mobile virtual keyboards resize `window.visualViewport` (while preserving native pinch-zoom when `viewport.scale !== 1`).
- **Sidebar (`aside#side`):**
  - Resizable on desktop (`--side-w`, default `264px`) via `#side-resize` drag handle; collapsible to a `60px` icon rail (`aside#side.collapsed`) that hides text labels via accessible clip rules and exposes `#history-rail`.
  - Top navigation items (`.side-item`) switch between primary views (`chat`, `analytics`, `settings`) or open workspace panels (`cron`, `projects`, `board`, `memory`, `skills`, `lessons`). Active view uses `[aria-current="page"]` (`background: var(--acc-soft); color: var(--primary)`).
  - **Session History (`#sessions`):** Two levels, one folder open at a time. Level 1 lists one `.folder-row` per project, plus `Chats` for sessions without a named project (favourites first). Each row shows the last activity time and a count per non-idle status (all except `ready` and `stopped`), with a trailing `.folder-chevron` that swaps for a sibling `.folder-quick-new` `+` button on hover/focus (always visible on coarse/touch pointers) to start a new session in that project without opening its folder. Choosing `.folder-open` opens that folder (persisted in `localStorage` as `luna.side.project`). A fixed `.folder-head` shows `#history-back`, the project name, the project menu, and a new-session button; with workers it adds `.device-chip` machine filters (`All` plus each machine with counts; a machine with no sessions is disabled; an offline machine disables new sessions and shows a note). Pinned sessions sort first, followed by most recent activity. Search lists matches from every folder, each with its project and machine. With no named projects, the only folder is always open and has no back button.
  - **Mobile Drawer (`@media (max-width: 760px)`):** Slides over the canvas (`width: 280px`, `transform: translateX(-100%)` → `translateX(0)` when `.open`) with a backdrop scrim (`#shade`).
- **Command Palette (`CommandPalette.vue`, `#command-palette`):**
  - `Ctrl+K` / `Cmd+K` or the sidebar `#open-palette` entry opens a centered `--popover` dialog (`width: min(640px, 100vw - 24px)`). It is not available in the split-view second pane.
  - Every entry runs an existing action: go to a page or Settings tab, open a panel, toggle the sidebar or split view, open or create a conversation, choose a model or thinking level, or write a boolean/enum setting through `PUT /v1/settings`.
  - Entries show real state only: a check for the current page, panel, conversation, model, or option, and an `On`/`Off` chip for toggles. Settings entries reload from the server on every open.
  - Toggles keep the palette open and confirm the save in `#palette-status`. Writes are refused while the Settings page has unsaved edits.
- **Top Header (`#top`):**
  - Displays current conversation title (`#title`), live session status (`#session-status` when state !== `ready`), rate-limit auto-continue countdown with inline `Cancel` (`#limit-wait`), `#statusbar` usage disclosure, `#new-session` button (creates a session in the active project), and `#more` (`SessionPanel` trigger).

### 2. Chat Transcript, Media, & Tool Renderers (`web/src/components/chat/`)

- **Single Centered Column (`#log`):**
  - Horizontal padding centers a `760px` reading column (`padding-left: max(24px, calc((100% - 760px) / 2 - var(--gutter-shift, 0px)))`, `padding-right: max(24px, calc((100% - 760px) / 2 + var(--gutter-shift, 0px)))`; `20px 16px` on mobile) with `24px` vertical message gap. `--gutter-shift` compensates for up to half the left sidebar offset when room allows so the reading column stays centered in the viewport rather than drifting right, while freeing extra right-gutter space for `#session-rail`.
  - Empty conversations display `#welcome` centered in the transcript.
  - Conversation context that is not a control is the last row **inside** the scroller, through the `Transcript` default slot (the undocked `GitStatus` footer). A wheel or touch drag that starts on it scrolls the transcript instead of dead-ending on fixed chrome, and it stays visible whenever the log is at the bottom. Only the extras dock, queued dock, and composer sit outside `#log`.
  - Floating scroll jump buttons (`.transcript-jumps`) anchor at `right: 24px; bottom: 140px` when scrolled away from the bottom.
- **Message Presentation:**
  - **User messages (`.msg.user`):** Right-aligned (`align-self: flex-end`), `max-width: 85%` (`92%` on mobile), `background: var(--secondary)`, `border: 1px solid var(--border)`, `border-radius: var(--radius)`, `white-space: pre-wrap`.
  - **Assistant messages (`.msg.assistant`):** Full-bleed prose rendered directly on `--background` (never wrapped in a filled card), prefixed by the `Luna` label (`::before`), using `.md` Markdown styles and copyable code blocks (`.codewrap` + `pre.code`).
  - **In-place Media (`MEDIA:` directives & attachments):** Images (`.att`), audio, video (`.att-video`), and downloadable file cards (`.att-file`) render inline within the message flow where written, never stripped or grouped only at the end. Missing files render `.att-missing` with a destructive border tint.
  - **Thinking & Background Reports (`.thinking`, `.background-report`):** Collapsible `<details>` cards above assistant prose with `max-height: 300px` scrollable preformatted content.
- **Tool Call Rows (`ToolCall.vue`, `.tool`):**
  - Collapsible `<details>` cards (`background: var(--card)`, `border: 1px solid var(--border)`, `border-radius: var(--radius)`).
  - `<summary>` (`min-height: 40px`) displays the status icon, monospace `.tool-name`, truncated `.tool-summary` (or `.tool-counts` / `.tool-exit`), and right-aligned `.tool-state`.
  - Failed tools (`data-state="failed"`) tint the border and background with `--destructive` (`color-mix(in srgb, var(--destructive) 4%, var(--card))`).
  - **Specialized Tool Renderers (`tool/`):**
    - `DiffView.vue` (`.diff`): 3-column grid (`line`, `sign`, `text`) with semantic addition (`--ok`) and deletion (`--destructive`) row tints and header `+N / -N` counts.
    - `CodeView.vue` (`.code-view`): 2-column line-numbered source viewer with incremental truncation expansion (`.code-more`).
    - `TerminalView.vue` (`pre.terminal`): Darkened terminal surface (`color-mix(in srgb, black 25%, var(--card))`) with ANSI color classes (`.ansi-red`, `.ansi-green`, etc.).
    - Structured views for task lists (`.tool-tasks`), search hits (`.tool-hits`), Q&A prompts (`.tool-answers`), and inline tool images (`img.tool-image`), plus a collapsible raw payload section (`.tool-raw`).
- **Extras Dock (`Extras.vue`, `#extras`):**
  - Sits between `#log` and `#compose` (`max-height: 28dvh`, `25dvh` on mobile; hidden when `:empty`).
  - Hosts interactive `ask_user_question` cards (`.opt` with `:has(input:checked)` highlighted in `--primary` / `--acc-soft`), live subagent/background process activity disclosures (`.activity`), and active todo lists (`.todo-item`).

### 3. Composer & Header Status Bar (`web/src/components/composer/`, `StatusBar.vue`)

- **Composer Container (`#compose` & `#composer`):**
  - Centered dock (`max-width: 824px`, `padding: 10px 32px`, `8px 12px` on mobile, respecting `env(safe-area-inset-bottom)`).
  - `#composer` uses `background: var(--card)`, `border: 1px solid var(--input)`, `border-radius: var(--radius)`, shifting border to `color-mix(in srgb, var(--primary) 55%, var(--border))` on `:focus-within`.
  - **Attachment strip (`#atts`):** Thumbnail previews (`height: 54px`) with circular remove buttons above the textarea.
  - **Auto-sizing input (`#input`):** `min-height: 38px`, `max-height: 22dvh`, transparent background.
  - **Input Integrity:** Never modify, prefill, or inject text into the composer input box without explicit user consent or a direct user-initiated action.
- **Bottom Action Bar (`.compose-bar`):**
  - Left: Attachment trigger (`#attach`), Model picker trigger (`#model`, truncated `max-width: 240px`, `160px` on mobile), and Reasoning gauge button (`#think`, SVG dial with 7 colored ticks and needle).
  - Right (`.compose-actions`): Stop button (`#stop`, secondary surface) and Send button (`#send`, primary fill).
- **Autocomplete Menus (`#mention-menu`, `#command-menu`):**
  - Positioned above the composer (`bottom: calc(100% + 8px)`, `max-height: min(320px, 46dvh)`).
  - `#` opens `#mention-menu`: groups project board cards by status (`todo`, `backlog`, `review`, `in_progress`, `done`) with priority dots, `#id`, subject, and priority badge.
  - `/` opens `#command-menu`: groups slash commands (`Side & Skills`, `Busy & Queue`, `Turn Control`) with category dot, monospace command name, argument signature, and description.
- **Header Context & Usage Disclosure (`#statusbar`):**
  - Lives in `#top` (never below the composer).
  - `<summary>` shows a compact context gauge (`#context-meter` with `#context-fill` colored `--ok`, `--warn` at `data-level="amber"`, or `--destructive` at `data-level="red"`), tabular percentage (`.usage-percent`), and session cost (`.usage-cost`, hidden on mobile).
  - Opening `<details>` reveals `.usage-details` popover (`width: min(320px, calc(100vw - 32px))`) with per-model token breakdowns and manual compaction controls.
- **Session Rail (`#session-rail`):**
  - Floats as an absolute card stack (`252px` wide, `top: 12px; right: 36px;`, clearing `.user-rail` and `#jump`) in the right gutter when the right gutter width (`(tileWidth - 760) / 2 + gutterShift`) is at least `316px` (undocks below `300px`; the dead zone prevents flicker and guarantees clearance). Split-view tiles measure their own width.
  - Shows only when there is active or rich content (goal, activity, review jobs, or dirty/unpushed `GitStatus`) and no right-side `WorkDock` is open. Empty sessions and clean-repo sessions render zero side chrome (`GitStatus` stays inline in `Transcript`).
  - Can be minimized into a compact live summary pill in the top-right corner (`luna.rail.collapsed`).
  - Order: Git (`GitStatus`), Goal, Processes, Review agents, Subagents, then Tasks (the long list goes last).
  - Each item renders in exactly one place. When floating, `#extras` and the inline `GitStatus` are not mounted. When unfloated, they return inline.

### 4. Full Pages & Workspace Panels (`web/src/pages/`, `web/src/components/panels/`)

- **Full-Page Views (`SettingsPage.vue`, `AnalyticsPage.vue`):**
  - Render in the main content area when `ui.view !== 'chat'`.
  - **Settings (`SettingsPage.vue`):** 6 vertical/horizontal navigation tabs (`General`, `Models`, `Context`, `Tools`, `Automation`, `Workspace`) sharing one unsaved draft with dirty-navigation protection, inline status summaries (`groupStatus`), and collapsible manager disclosures (`details.card > summary` + `.manager-body`).
  - **Analytics (`AnalyticsPage.vue`):** Responsive usage layouts with explicit empty, loading, and error states.
- **Terminal dock (`TerminalDock.vue`, `TermView.vue`):**
  - A bottom dock inside `<main>`, shown when `terminal.open` and a session is active. Opened by the `#toggle-terminal` header button (`aria-pressed`), **Ctrl+\`**, or the command palette.
  - Tabs use an ARIA tablist with arrow-key navigation. The resize handle works by drag and by keyboard. Height persists under `luna.terminal.height`.
  - Only `web/src/lib/term-adapter.ts` imports ghostty-web. The theme comes from CSS variables, with `--mono` as the font. When `terminal.user` is off the dock shows an "off" state that links to Settings > Tools. No emojis, no floating buttons.
  - Mobile key chips (Esc, Tab, Ctrl, Alt, arrows) are not built yet; see the board.

- **Panels & Floating Windows (`PanelHost.vue`):**
  - Slide-over drawer panels (`max-w-xl`, right-aligned: `session`, `agents`, `memory`, `skills`, `providers`, `mcp`, `lessons`) use `#pbody` with shared `.card`, `.row`, `.grid`, and `.field-label` layout rules.
  - **Centered Floating Windows (`WINDOWS` in `PanelHost.vue`):**
    - `board` (`.board-window`): `height: 94dvh`, `max-height: calc(100dvh - 48px)`, full-width kanban workspace.
    - `projects` (`.projects-window`): `max-width: 900px`, `height: min(600px, calc(100dvh - 48px))`, split list + detail window.
    - `cron` (`CronPanel.vue`, `.cron-window`): maximum width `1180px`, height `94%`, responsive list and detail layout. Reports is an unread inbox, Jobs manages schedules and health, and History holds read and superseded reports, newest first, with a job filter. Opening a report marks it read without closing its detail. Back returns to the list. New reports replace older reports for that job. Mark unread restores the latest report; superseded reports remain in History. Mark all read clears the current inbox. The sidebar badge counts unread inbox entries and hides at zero. Closing preserves the active tab, job selection, history filter, and unfinished job edit.

---

## Generated UI (rich fences)

`web/src/lib/segments.ts` splits `ui`, `html`, `mermaid`, and `math` fences out of an assistant reply. `web/src/components/chat/genui/` renders them. `Block.vue` is the shared frame for all four; do not add per-block headers or cards around it.

- **Frame:** no header bar. A hover toolbar (always visible with `hover: none`) holds icon buttons: source/result toggle, copy, and expand or reload where they apply.
- **Invalid:** the source in a code block, plus one `--destructive` line with the reason. Never fail silently.
- **Streaming (fence not closed):** one muted status line (`Building diagram…`). Partial content is never parsed or rendered.
- **Surfaces:** charts, plots, and diagrams sit on one `--card` surface with a `--border` outline. Inline HTML brings its own layout and inherits the theme variables.
- **Colors:** series and diagram accents use `--chart-1` to `--chart-6`. No raw hex in templates. A series keeps its color when another series is hidden. Mermaid gets literal values read from the live theme.
- **Charts (`ui`):** `line`, `area`, `bar` (grouped or `stacked`), `pie`, `donut`. Legend items are `<button aria-pressed>`; hovering shows a readout row. Plots use native `input[type=range]` sliders and make no request.
- **HTML:** static markup renders inline in a shadow root after sanitizing (`web/src/lib/genui/sanitize.ts`). Markup with script goes to the sandboxed iframe, which is transparent, themed, and sized to its content. A frame exists only within about 800 px of the visible transcript; far frames are removed so their scripts stop, and they reload when they come back. Never render model HTML in the app document without that sanitizer.
- **Actions:** `data-luna-prompt` fills the composer. Generated UI never sends a message itself.
- **Limits:** at most 4 `ui` and `html` blocks per message. Extra blocks show their source and the reason.
- **Data:** a widget shows only data the model got from the user or a tool. No decorative or placeholder charts.
- **Fences:** `web/src/lib/fences.ts` is the single fence scanner (CommonMark open and close rules). Do not add another.

## Do's and Don'ts

### Do's
- **DO** use `@lucide/vue` vector icons for all application controls, navigation items, and status indicators.
- **DO** use semantic CSS variables (`var(--card)`, `var(--border)`, `var(--muted-foreground)`, etc.) so surfaces and contrast stay consistent.
- **DO** keep secondary row actions (such as model pin `.model-pin` or item delete/remove buttons) as **sibling `<button>` elements** beside the primary selection button so disabled items remain removable and HTML remains valid.
- **DO** refresh shared picker/panel state (`ModelPicker`, `ProvidersPanel`, `McpPanel`, `BoardPanel`, `#mention-menu`) whenever the dialog or popover opens, not just on initial component mount.
- **DO** provide a `crypto.getRandomValues()` or timestamp/hex fallback whenever generating client-side IDs (never call `crypto.randomUUID()` unconditionally, as plain HTTP LAN origins disable it).
- **DO** pair status colors with text labels, icons, or `data-status` / `aria-label` attributes so state is never communicated by color alone.

### Don'ts
- **DON'T** use emoji characters in application UI, buttons, headers, badges, or empty states. (Emojis inside user or assistant chat messages are user content and remain untouched.)
- **DON'T** add Floating Action Buttons (FABs) that float over content; place actions in `#top`, `.compose-bar`, or panel headers (`header`).
- **DON'T** wrap assistant markdown prose in filled cards or apply gradient backgrounds to chat surfaces or user bubbles.
- **DON'T** nest `<button>` elements inside `<button>` or `<summary>` interactive targets in ways that break keyboard focus or click routing.
- **DON'T** use blind cycle buttons when a `<select>`, popover, or radio group lets the user see and pick the target state directly.
- **DON'T** place session token/context usage bars underneath the composer; keep session usage inside `#statusbar` in `#top`.
- **DON'T** modify, prefill, or inject text into the composer/input box without explicit user consent or a direct user-initiated action.

---

## Accessibility, Viewport, and Verification Requirements

### Keyboard, Focus, and ARIA Contracts
- **Focus Ring:** Every interactive element must preserve a visible `:focus-visible` outline (`2px solid var(--ring)`). Only suppress `:focus-visible` on `#input` where the parent `#composer:focus-within` provides the focus ring.
- **Modal & Drawer Focus Trapping (`App.vue`):**
  - When `#login`, `#panel [role="dialog"]`, or the mobile sidebar drawer (`#side`) is open, background regions (`Sidebar`, `#main`, full pages) must receive the `:inert` attribute.
  - `Tab` / `Shift+Tab` cycles focus strictly within the active modal/drawer root.
  - `Escape` closes the topmost active overlay (`#mention-menu` / `#command-menu` → `ui.panel` → mobile `ui.drawer`).
- **Arrow-Key Roving Navigation:**
  - Settings tabs (`moveTab`) and section sub-views (`moveView`) support `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, and `End`.
  - Composer autocomplete menus (`#mention-menu`, `#command-menu`) support `ArrowUp` / `ArrowDown` selection, `Enter` / `Tab` insertion, and `Escape` dismissal.
- **ARIA Semantics:**
  - Icon-only buttons (`.icon-button`, `#send`, `#stop`, `#think`, `#attach`, `#pclose`) must carry an explicit `aria-label`.
  - Disclosure triggers and popovers must maintain accurate `aria-expanded`, `aria-controls`, and `aria-current` attributes.
  - Live status indicators (`#session-status`, `#limit-wait`, `#loginErr`) use `role="status"` or `role="alert"`.
- **Reduced Motion:** Respect `@media (prefers-reduced-motion: reduce)` by disabling transitions on `aside#side`, `.disclosure-chevron`, and `#context-fill`.

### Responsive & Mobile Viewport (`<= 760px`)
- Breakpoint: `@media (max-width: 760px)` (`useMobile()` in `web/src/lib/dom.ts`).
- Verify changed views at both desktop (`1280×800`) and mobile (`390×844`) viewports, including virtual keyboard resize behavior via `trackViewport()`.
- On mobile, `#side` acts as an off-canvas overlay drawer, `#statusbar` hides `.usage-summary-label` and `.usage-cost` to preserve header space, and floating windows (`.float-window`) expand to `calc(100dvh - 16px)` with `8px` outer padding.

### UI Verification Gates
Every UI change must be verified before opening a PR:

```bash
bun run typecheck:web
bun run build:web
```

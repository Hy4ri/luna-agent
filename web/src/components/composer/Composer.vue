<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { ArrowUp, Square, FileText, Loader2, Camera } from "@lucide/vue";
import { json, post } from "@/lib/api";
import { composer, addAttachment, captureAttachmentContext, removeAttachment, saveDraft, restoreDraft, submitDraft, retrySend } from "@/stores/composer";
import { chat, busy, sendDisabled, stopDisabled, stopRun, addErr } from "@/stores/chat";
import { history, loadProjects } from "@/stores/sessions";
import { modelLabel, loadModels } from "@/stores/models";
import { boardChanged, focusInput } from "@/stores/app";
import ModelPicker from "./ModelPicker.vue";
import ReportContext from "../chat/ReportContext.vue";
import ReasoningControl from "./ReasoningControl.vue";
import { searchMentions, type MentionItem } from "@/lib/mention-sources";

type Status = "todo" | "backlog" | "review" | "in_progress" | "done";
type Priority = "urgent" | "high" | "medium" | "low";
type MentionCard = {
  id: number;
  project: number;
  subject: string;
  description: string;
  status: Status;
  priority: Priority;
  owner: string | null;
  labels: string[];
  blockedBy: number[];
  archived: boolean;
};

const CATEGORY_ORDER: Status[] = ["todo", "backlog", "review", "in_progress", "done"];
const CATEGORY_LABEL: Record<Status, string> = {
  todo: "To do",
  backlog: "Backlog",
  review: "Review",
  in_progress: "In progress",
  done: "Done",
};
const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, medium: 1, low: 0 };

type CommandCategory = "side" | "busy" | "session";
type SlashCommandItem = {
  id: string;
  insert: string;
  label: string;
  args?: string;
  description: string;
  category: CommandCategory;
};

const COMMAND_CATEGORY_ORDER: CommandCategory[] = ["side", "busy", "session"];
const COMMAND_CATEGORY_LABEL: Record<CommandCategory, string> = {
  side: "Side & Skills",
  busy: "Busy & Queue",
  session: "Turn Control",
};

const SLASH_COMMANDS: SlashCommandItem[] = [
  { id: "usage", insert: "/usage", label: "/usage", description: "Show recorded session totals and Claude plan usage", category: "session" },
  { id: "cost", insert: "/cost", label: "/cost", description: "Alias for /usage", category: "session" },
  { id: "undo", insert: "/undo ", label: "/undo", args: "<N>", description: "Remove the last N user messages and replies from model context; keep chat history", category: "session" },
  { id: "btw", insert: "/btw ", label: "/btw", args: "<question>", description: "Ask a side question without tools or main history", category: "side" },
  { id: "bg", insert: "/bg ", label: "/bg", args: "<prompt>", description: "Run a background task with tools in a side conversation", category: "side" },
  { id: "review", insert: "/review", label: "/review", args: "[focus]", description: "Review this session's code and request coverage with a read-only model", category: "side" },
  { id: "learn", insert: "/learn ", label: "/learn", args: "<source> [objective]", description: "Study a URL, repo, or file and record a skill", category: "side" },
  { id: "grill", insert: "/grill ", label: "/grill", args: "<topic>", description: "Interview me about a plan until every decision is resolved", category: "side" },
  { id: "skillcraft", insert: "/skillcraft ", label: "/skillcraft", args: "<skill idea>", description: "Interview me to craft or update a skill", category: "side" },
  { id: "queue", insert: "/queue ", label: "/queue", args: "<message>", description: "Queue a follow-up message for the next turn", category: "busy" },
  { id: "steer", insert: "/steer ", label: "/steer", args: "<message>", description: "Steer the active turn after the current tool batch", category: "busy" },
  { id: "redirect", insert: "/redirect ", label: "/redirect", args: "<message>", description: "Interrupt and redirect the current model generation", category: "busy" },
  { id: "queue list", insert: "/queue list", label: "/queue list", description: "List queued follow-up messages", category: "busy" },
  { id: "queue edit", insert: "/queue edit ", label: "/queue edit", args: "<N> <text>", description: "Edit queued message N", category: "busy" },
  { id: "queue remove", insert: "/queue remove ", label: "/queue remove", args: "<N>", description: "Remove queued message N", category: "busy" },
  { id: "queue move", insert: "/queue move ", label: "/queue move", args: "<A> <B>", description: "Move queued message A to position B", category: "busy" },
  { id: "queue clear", insert: "/queue clear", label: "/queue clear", description: "Clear all queued messages", category: "busy" },
  { id: "stop", insert: "/stop", label: "/stop", description: "Stop the active turn immediately", category: "session" },
  { id: "compact", insert: "/compact", label: "/compact", description: "Summarize older context now", category: "session" },
  { id: "models", insert: "/models", label: "/models", description: "Open the model picker", category: "session" },
];

const inputRef = ref<HTMLTextAreaElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);
const cameraRef = ref<HTMLInputElement | null>(null);
const mentionMenuRef = ref<HTMLElement | null>(null);
const commandMenuRef = ref<HTMLElement | null>(null);
const atMenuRef = ref<HTMLElement | null>(null);
const pickerOpen = ref(false);

const boardCards = ref<MentionCard[]>([]);
const loadedPid = ref<number | null>(null);
const mentionMatch = ref<{ start: number; end: number; query: string } | null>(null);
const activeMentionIndex = ref(0);
const commandMatch = ref<{ start: number; end: number; query: string } | null>(null);
const activeCommandIndex = ref(0);
const atMatch = ref<{ start: number; end: number; query: string } | null>(null);
const activeAtIndex = ref(0);
let loadTicket = 0;

const activeProjectId = computed<number | null>(() => {
  if (chat.session) {
    const p = chat.project ?? history.list.find(s => String(s.id) === String(chat.session))?.project ?? null;
    return p !== null ? Number(p) : null;
  }
  if (chat.project !== null) return Number(chat.project);
  let saved = 0;
  try { saved = Number(localStorage.getItem("luna.project") || 0); } catch {}
  if (history.projects.some(p => p.id === saved)) return saved;
  return history.projects[0]?.id ?? null;
});

async function fetchMentionCards(pid: number | null, force = false) {
  if (pid === null) {
    boardCards.value = [];
    loadedPid.value = null;
    return;
  }
  if (!force && loadedPid.value === pid && boardCards.value.length > 0) return;
  const ticket = ++loadTicket;
  try {
    const data = await json<{ cards: MentionCard[] }>(`/v1/projects/${pid}/board`);
    if (ticket !== loadTicket) return;
    boardCards.value = data.cards || [];
    loadedPid.value = pid;
  } catch {
    if (ticket !== loadTicket) return;
  }
}

const sortedMentionItems = computed<MentionCard[]>(() => {
  const m = mentionMatch.value;
  if (!m) return [];
  const q = m.query.trim().toLowerCase();
  const isDigits = /^\d+$/.test(q);
  const filtered = boardCards.value.filter(c => {
    if (!q) return true;
    const idStr = String(c.id);
    if (isDigits) {
      return idStr.startsWith(q);
    }
    return idStr.startsWith(q) || c.subject.toLowerCase().includes(q) || c.labels.some(l => l.toLowerCase().includes(q));
  });
  return [...filtered].sort((a, b) => {
    const catDiff = CATEGORY_ORDER.indexOf(a.status) - CATEGORY_ORDER.indexOf(b.status);
    if (catDiff !== 0) return catDiff;
    const priDiff = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (priDiff !== 0) return priDiff;
    return a.id - b.id;
  });
});

const mentionGroups = computed(() => {
  const items = sortedMentionItems.value;
  const groups: { status: Status; label: string; items: { card: MentionCard; flatIndex: number }[] }[] = [];
  let flatIndex = 0;
  for (const status of CATEGORY_ORDER) {
    const inStatus = items.filter(c => c.status === status);
    if (!inStatus.length) continue;
    groups.push({
      status,
      label: CATEGORY_LABEL[status],
      items: inStatus.map(card => ({ card, flatIndex: flatIndex++ })),
    });
  }
  return groups;
});

const mentionOpen = computed(() => !!mentionMatch.value && activeProjectId.value !== null && sortedMentionItems.value.length > 0);

const sortedCommandItems = computed<SlashCommandItem[]>(() => {
  const m = commandMatch.value;
  if (!m) return [];
  const q = m.query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(cmd => {
    if (cmd.id.startsWith(q) || cmd.label.slice(1).startsWith(q)) return true;
    const words = cmd.id.split(" ");
    if (!q.includes(" ") && words.some(w => w.startsWith(q))) return true;
    return false;
  });
});

const commandGroups = computed(() => {
  const items = sortedCommandItems.value;
  const groups: { category: CommandCategory; label: string; items: { cmd: SlashCommandItem; flatIndex: number }[] }[] = [];
  let flatIndex = 0;
  for (const category of COMMAND_CATEGORY_ORDER) {
    const inCat = items.filter(c => c.category === category);
    if (!inCat.length) continue;
    groups.push({
      category,
      label: COMMAND_CATEGORY_LABEL[category],
      items: inCat.map(cmd => ({ cmd, flatIndex: flatIndex++ })),
    });
  }
  return groups;
});

const commandOpen = computed(() => !mentionOpen.value && !!commandMatch.value && sortedCommandItems.value.length > 0);

// `@` mentions: one group per registered source (sessions now; files and others later).
const atGroups = computed(() => {
  if (!atMatch.value) return [];
  let flatIndex = 0;
  return searchMentions(atMatch.value.query, {
    session: chat.session ? String(chat.session) : null,
    worker: chat.draftWorker,
    project: activeProjectId.value,
    cwd: chat.draftCwd,
  })
    .map(g => ({ id: g.source.id, label: g.source.label, items: g.items.map(item => ({ item, flatIndex: flatIndex++ })) }));
});
const atItems = computed<MentionItem[]>(() => atGroups.value.flatMap(g => g.items.map(e => e.item)));
const atOpen = computed(() => !mentionOpen.value && !commandOpen.value && atItems.value.length > 0);

function updateAtState() {
  const el = inputRef.value;
  if (!el) { atMatch.value = null; return; }
  const caret = el.selectionStart ?? el.value.length;
  const m = /(?:^|[\s([{"'])@([^\s@]*)$/.exec(el.value.slice(0, caret));
  if (!m) { atMatch.value = null; return; }
  const query = m[1] || "";
  const prev = atMatch.value;
  atMatch.value = { start: caret - query.length - 1, end: caret, query };
  if (!prev || prev.query !== query) activeAtIndex.value = 0;
}

function selectAt(item: MentionItem) {
  const el = inputRef.value;
  const m = atMatch.value;
  if (!el || !m) return;
  const before = el.value.slice(0, m.start);
  const after = el.value.slice(m.end);
  // A directory keeps the caret inside the token, so the list moves on to that directory.
  const inserted = item.token + (item.dir || after.startsWith(" ") || after.startsWith("\n") ? "" : " ");
  const nextText = before + inserted + after;
  const nextCaret = before.length + inserted.length;
  el.value = nextText;
  composer.text = nextText;
  atMatch.value = null;
  grow();
  saveDraft();
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(nextCaret, nextCaret);
    if (item.dir) updateAtState();
  });
}

function updateCommandState() {
  const el = inputRef.value;
  if (!el) {
    commandMatch.value = null;
    return;
  }
  const text = el.value;
  const caret = el.selectionStart ?? text.length;
  const before = text.slice(0, caret);
  const lead = /^(\s*)\/([^\n]*)$/.exec(before);
  if (!lead) {
    commandMatch.value = null;
    return;
  }
  const rawAfterSlash = lead[2] || "";
  const slashStart = (lead[1] || "").length;
  const tokens = rawAfterSlash.trimStart().split(/\s+/).filter(Boolean);
  const firstToken = (tokens[0] || "").toLowerCase();
  const hasTrailingSpace = /\s$/.test(rawAfterSlash);

  if (firstToken === "queue") {
    const subToken = (tokens[1] || "").toLowerCase();
    if (tokens.length > 2 || (tokens.length === 2 && hasTrailingSpace)) {
      commandMatch.value = null;
      return;
    }
    if (tokens.length === 2 && !["list", "edit", "remove", "move", "clear"].some(s => s.startsWith(subToken))) {
      commandMatch.value = null;
      return;
    }
  } else if (tokens.length > 1 || (tokens.length === 1 && hasTrailingSpace)) {
    commandMatch.value = null;
    return;
  }

  const query = rawAfterSlash.replace(/\s+/g, " ");
  const prev = commandMatch.value;
  commandMatch.value = { start: slashStart, end: caret, query };
  if (!prev || prev.query !== query) {
    activeCommandIndex.value = 0;
  } else if (activeCommandIndex.value >= sortedCommandItems.value.length) {
    activeCommandIndex.value = Math.max(0, sortedCommandItems.value.length - 1);
  }
}

function selectCommand(cmd: SlashCommandItem) {
  const el = inputRef.value;
  const m = commandMatch.value;
  if (!el || !m) return;
  const before = el.value.slice(0, m.start);
  const after = el.value.slice(m.end).replace(/^\s+/, "");
  const inserted = cmd.insert;
  const nextText = before + inserted + (after ? (inserted.endsWith(" ") ? after : " " + after) : "");
  const nextCaret = before.length + inserted.length;
  el.value = nextText;
  composer.text = nextText;
  commandMatch.value = null;
  grow();
  saveDraft();
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(nextCaret, nextCaret);
  });
}

function scrollActiveCommandIntoView() {
  void nextTick(() => {
    const activeEl = commandMenuRef.value?.querySelector<HTMLElement>('[data-command-active="true"]');
    activeEl?.scrollIntoView({ block: "nearest" });
  });
}

function updateMentionState() {
  const el = inputRef.value;
  if (!el) {
    mentionMatch.value = null;
    return;
  }
  const text = el.value;
  const caret = el.selectionStart ?? text.length;
  const before = text.slice(0, caret);
  const m = /(?:^|[\s([{"'])#([^\s#]*)$/.exec(before);
  if (!m || activeProjectId.value === null) {
    mentionMatch.value = null;
    return;
  }
  const query = m[1] || "";
  const hashStart = caret - query.length - 1;
  const prev = mentionMatch.value;
  mentionMatch.value = { start: hashStart, end: caret, query };
  if (!prev || prev.start !== hashStart) {
    void fetchMentionCards(activeProjectId.value, true);
  } else if (loadedPid.value !== activeProjectId.value || boardCards.value.length === 0) {
    void fetchMentionCards(activeProjectId.value, true);
  }
  if (!prev || prev.query !== query) {
    activeMentionIndex.value = 0;
  } else if (activeMentionIndex.value >= sortedMentionItems.value.length) {
    activeMentionIndex.value = Math.max(0, sortedMentionItems.value.length - 1);
  }
}

function selectMention(card: MentionCard) {
  const el = inputRef.value;
  const m = mentionMatch.value;
  if (!el || !m) return;
  const before = el.value.slice(0, m.start);
  const after = el.value.slice(m.end);
  const needsSpace = !after.startsWith(" ") && !after.startsWith("\n");
  const inserted = `#${card.id}${needsSpace ? " " : ""}`;
  const nextText = before + inserted + after;
  const nextCaret = before.length + inserted.length;
  el.value = nextText;
  composer.text = nextText;
  mentionMatch.value = null;
  grow();
  saveDraft();
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(nextCaret, nextCaret);
  });
}

function scrollActiveMentionIntoView() {
  void nextTick(() => {
    const activeEl = mentionMenuRef.value?.querySelector<HTMLElement>('[data-mention-active="true"]');
    activeEl?.scrollIntoView({ block: "nearest" });
  });
}

function isRasterImage(mimeType?: string): boolean {
  return /^(image\/(png|jpeg|gif|webp))$/i.test(mimeType || "");
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const hasDraft = computed(() => composer.text.trim().length > 0 || composer.attachments.length > 0 || composer.uploadingCount > 0);
const isSendDisabled = computed(() => sendDisabled.value || composer.uploadingCount > 0 || !hasDraft.value);
const showStop = busy;
const sendHidden = computed(() => showStop.value && !hasDraft.value);

function grow() {
  if (!inputRef.value) return;
  inputRef.value.style.height = "auto";
  inputRef.value.style.height = Math.max(inputRef.value.scrollHeight + 2, 38) + "px";
}

function handleInput() {
  composer.text = inputRef.value?.value || "";
  grow();
  saveDraft();
  updateMentionState();
  updateCommandState();
  updateAtState();
}

/** Run client-side commands (/compact, /models); returns true when handled. */
function runLocalCommand(): boolean {
  const cmd = /^\/(compact|compress|models?)$/.exec(composer.text.trim())?.[1];
  if (!cmd) return false;
  composer.text = ""; saveDraft();
  if (cmd.startsWith("model")) {
    document.getElementById("model-picker")?.showPopover?.();
  } else if (!chat.session) {
    addErr("/compact needs an open session.");
  } else if (busy.value) {
    addErr("/compact is not available while busy.");
  } else {
    post(`/v1/sessions/${chat.session}/compact`).catch(error => addErr((error as Error).message));
  }
  return true;
}

function submit() {
  if (!runLocalCommand()) submitDraft();
}

function handleKeydown(e: KeyboardEvent) {
  if (mentionOpen.value) {
    const total = sortedMentionItems.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeMentionIndex.value = (activeMentionIndex.value + 1) % total;
      scrollActiveMentionIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeMentionIndex.value = (activeMentionIndex.value - 1 + total) % total;
      scrollActiveMentionIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing) {
      const chosen = sortedMentionItems.value[activeMentionIndex.value];
      if (chosen) {
        e.preventDefault();
        selectMention(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mentionMatch.value = null;
      return;
    }
  }
  if (commandOpen.value) {
    const total = sortedCommandItems.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value + 1) % total;
      scrollActiveCommandIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value - 1 + total) % total;
      scrollActiveCommandIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing) {
      const chosen = sortedCommandItems.value[activeCommandIndex.value];
      if (chosen) {
        e.preventDefault();
        selectCommand(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      commandMatch.value = null;
      return;
    }
  }
  if (atOpen.value) {
    const total = atItems.value.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activeAtIndex.value = (activeAtIndex.value + (e.key === "ArrowDown" ? 1 : total - 1)) % total;
      void nextTick(() => atMenuRef.value?.querySelector<HTMLElement>('[data-at-active="true"]')?.scrollIntoView({ block: "nearest" }));
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing) {
      const chosen = atItems.value[activeAtIndex.value];
      if (chosen) { e.preventDefault(); selectAt(chosen); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); atMatch.value = null; return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(max-width: 760px)").matches) {
    e.preventDefault();
    if (!sendDisabled.value) submit();
  }
}

async function handleSubmit(e?: Event) {
  e?.preventDefault();
  mentionMatch.value = null;
  commandMatch.value = null;
  atMatch.value = null;
  if (!sendDisabled.value) submit();
}

function handleFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || !files.length) return;
  const context = captureAttachmentContext();
  const fileArray = Array.from(files);
  if (fileRef.value) fileRef.value.value = "";
  if (cameraRef.value) cameraRef.value.value = "";
  for (const f of fileArray) {
    void addAttachment(f, context);
  }
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const context = captureAttachmentContext();
  for (const it of Array.from(items)) {
    if (it.kind === "file") {
      const file = it.getAsFile();
      if (file) {
        e.preventDefault();
        void addAttachment(file, context);
      }
    }
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  const context = captureAttachmentContext();
  for (const f of Array.from(files)) {
    void addAttachment(f, context);
  }
}

watch(activeProjectId, (pid) => {
  void fetchMentionCards(pid, true);
}, { immediate: true });

watch(boardChanged, () => {
  if (activeProjectId.value !== null) void fetchMentionCards(activeProjectId.value, true);
});

watch(() => chat.session, () => {
  mentionMatch.value = null;
  commandMatch.value = null;
  atMatch.value = null;
  restoreDraft();
  if (inputRef.value) {
    inputRef.value.value = composer.text;
  }
  nextTick(() => grow());
});

watch(() => composer.text, (newVal) => {
  if (inputRef.value && inputRef.value.value !== newVal) {
    inputRef.value.value = newVal;
    grow();
  }
  if (!newVal) {
    mentionMatch.value = null;
    commandMatch.value = null;
    atMatch.value = null;
  }
});

watch(() => focusInput.value, () => {
  nextTick(() => {
    inputRef.value?.focus();
  });
});

function handleOutsideClick(e: MouseEvent) {
  if (!mentionMatch.value && !commandMatch.value && !atMatch.value) return;
  const t = e.target as Node | null;
  if (t && (inputRef.value?.contains(t) || mentionMenuRef.value?.contains(t) || commandMenuRef.value?.contains(t) || atMenuRef.value?.contains(t))) return;
  mentionMatch.value = null;
  commandMatch.value = null;
  atMatch.value = null;
}

onMounted(() => {
  document.addEventListener("paste", handlePaste);
  document.addEventListener("pointerdown", handleOutsideClick);
  if (!history.projects.length) void loadProjects();
  void loadModels();
  if (activeProjectId.value !== null) void fetchMentionCards(activeProjectId.value, true);
  restoreDraft();
  if (inputRef.value) {
    inputRef.value.value = composer.text;
  }
  nextTick(() => grow());
});

onBeforeUnmount(() => {
  document.removeEventListener("paste", handlePaste);
  document.removeEventListener("pointerdown", handleOutsideClick);
});
</script>

<template>
  <div id="composer">
    <div
      v-if="mentionOpen"
      id="mention-menu"
      ref="mentionMenuRef"
      role="listbox"
      aria-label="Board items"
    >
      <div
        v-for="group in mentionGroups"
        :key="group.status"
        class="mention-group"
        :data-status="group.status"
      >
        <div class="mention-group-header">
          <span class="mention-status-dot" :data-status="group.status" aria-hidden="true"></span>
          <span>{{ group.label }}</span>
        </div>
        <button
          v-for="entry in group.items"
          :key="entry.card.id"
          type="button"
          role="option"
          class="mention-item"
          :class="{ active: entry.flatIndex === activeMentionIndex }"
          :aria-selected="entry.flatIndex === activeMentionIndex ? 'true' : 'false'"
          :data-mention-active="entry.flatIndex === activeMentionIndex ? 'true' : undefined"
          :data-card-id="entry.card.id"
          :data-status="entry.card.status"
          :data-priority="entry.card.priority"
          @mousedown.prevent="selectMention(entry.card)"
          @mouseenter="activeMentionIndex = entry.flatIndex"
        >
          <span
            class="mention-priority-dot"
            :data-priority="entry.card.priority"
            :title="'Priority: ' + entry.card.priority"
            aria-hidden="true"
          ></span>
          <span class="mention-id">#{{ entry.card.id }}</span>
          <span dir="auto" class="mention-subject">{{ entry.card.subject }}</span>
          <span class="mention-priority-label" :data-priority="entry.card.priority">{{ entry.card.priority }}</span>
        </button>
      </div>
    </div>

    <div
      v-if="commandOpen"
      id="command-menu"
      ref="commandMenuRef"
      role="listbox"
      aria-label="Slash commands"
    >
      <div
        v-for="group in commandGroups"
        :key="group.category"
        class="mention-group command-group"
        :data-category="group.category"
      >
        <div class="mention-group-header">
          <span class="command-category-dot" :data-category="group.category" aria-hidden="true"></span>
          <span>{{ group.label }}</span>
        </div>
        <button
          v-for="entry in group.items"
          :key="entry.cmd.id"
          type="button"
          role="option"
          class="mention-item command-item"
          :class="{ active: entry.flatIndex === activeCommandIndex }"
          :aria-selected="entry.flatIndex === activeCommandIndex ? 'true' : 'false'"
          :data-command-active="entry.flatIndex === activeCommandIndex ? 'true' : undefined"
          :data-command="entry.cmd.id"
          :data-category="entry.cmd.category"
          @mousedown.prevent="selectCommand(entry.cmd)"
          @mouseenter="activeCommandIndex = entry.flatIndex"
        >
          <span class="command-name">{{ entry.cmd.label }}</span>
          <span v-if="entry.cmd.args" class="command-args">{{ entry.cmd.args }}</span>
          <span class="command-desc">{{ entry.cmd.description }}</span>
        </button>
      </div>
    </div>

    <div v-if="atOpen" id="at-menu" ref="atMenuRef" role="listbox" aria-label="Mentions">
      <div v-for="group in atGroups" :key="group.id" class="mention-group" :data-source="group.id">
        <div class="mention-group-header"><span>{{ group.label }}</span></div>
        <button
          v-for="entry in group.items"
          :key="entry.item.key"
          type="button"
          role="option"
          class="mention-item"
          :class="{ active: entry.flatIndex === activeAtIndex }"
          :aria-selected="entry.flatIndex === activeAtIndex ? 'true' : 'false'"
          :data-at-active="entry.flatIndex === activeAtIndex ? 'true' : undefined"
          :data-token="entry.item.token"
          @mousedown.prevent="selectAt(entry.item)"
          @mouseenter="activeAtIndex = entry.flatIndex"
        >
          <span dir="auto" class="mention-subject">{{ entry.item.label }}</span>
          <span dir="auto" v-if="entry.item.detail" class="at-detail">{{ entry.item.detail }}</span>
          <span v-if="entry.item.meta" class="at-meta">{{ entry.item.meta }}</span>
        </button>
      </div>
    </div>

    <div v-for="(a, i) in composer.attachments" :key="'report-' + i">
      <div v-if="a.report" class="cron-context">
        <ReportContext :text="a.data" />
        <button type="button" aria-label="Remove attached Cron report" @click="removeAttachment(i)">×</button>
      </div>
    </div>
    <div id="atts" aria-label="Attached files">
      <template v-for="(a, i) in composer.attachments" :key="i">
        <div v-if="!a.report" class="composer-att-item">
          <img v-if="isRasterImage(a.mimeType)" :src="a.url" :alt="a.name || 'attachment'" />
          <div v-else class="composer-file-pill">
            <FileText :size="14" aria-hidden="true" />
            <span class="composer-file-name" :title="a.name">{{ a.name || 'File' }}</span>
            <span v-if="a.size !== undefined" class="composer-file-size">{{ formatFileSize(a.size) }}</span>
          </div>
          <button
            type="button"
            :aria-label="'Remove attachment ' + (a.name || (i + 1))"
            @click="removeAttachment(i)"
          >
            ×
          </button>
        </div>
      </template>
      <div v-if="composer.uploadingCount > 0" class="composer-uploading-pill" role="status" aria-live="polite">
        <Loader2 :size="14" class="spin" aria-hidden="true" />
        <span>Uploading ({{ composer.uploadingCount }})…</span>
      </div>
    </div>

    <div
      v-if="composer.uploadError"
      class="msg err composer-upload-error"
      role="alert"
    >
      {{ composer.uploadError }}
    </div>

    <div
      id="busyFeedback"
      class="muted whitespace-pre-line"
      role="status"
      aria-live="polite"
      v-show="chat.busyFeedback"
    >
      {{ chat.busyFeedback }}
    </div>

    <!-- Send error banner / Retry send -->
    <div v-if="chat.session && composer.sendErrors.has(chat.session)" class="msg err send-error">
      <p>Send not confirmed: {{ composer.sendErrors.get(chat.session)?.message }}</p>
      <button type="button" :disabled="composer.submitting.has(chat.session)" @click="retrySend">Retry send</button>
    </div>

    <form id="form" @submit="handleSubmit" @drop="handleDrop" @dragover.prevent>
      <textarea
        id="input"
        dir="auto"
        ref="inputRef"
        rows="1"
        placeholder="Message Luna…"
        aria-label="Message Luna"
        @input="handleInput"
        @keydown="handleKeydown"
        @click="() => { updateMentionState(); updateCommandState(); updateAtState(); }"
        @keyup="e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { updateMentionState(); updateCommandState(); updateAtState(); } }"
      ></textarea>

      <div class="compose-bar">
        <button
          type="button"
          id="attach"
          class="icon-button"
          title="Attach files"
          aria-label="Attach files"
          @click="fileRef?.click()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3"/></svg>
        </button>
        <button
          type="button"
          id="camera"
          class="icon-button"
          title="Take photo"
          aria-label="Take photo"
          @click="cameraRef?.click()"
        >
          <Camera :size="18" aria-hidden="true" />
        </button>
        <input
          type="file"
          id="camera-file"
          ref="cameraRef"
          accept="image/*"
          capture="environment"
          hidden
          @change="handleFileChange"
        />
        <input
          type="file"
          id="file"
          ref="fileRef"
          multiple
          hidden
          @change="handleFileChange"
        />

        <div id="controls">
          <button
            id="model"
            type="button"
            popovertarget="model-picker"
            :aria-expanded="pickerOpen ? 'true' : 'false'"
            aria-label="Model"
          >
            {{ modelLabel }}
          </button>
          <ReasoningControl />
        </div>

        <div class="compose-actions">
          <button
            v-if="showStop"
            id="stop"
            type="button"
            class="icon-button"
            aria-label="Stop"
            title="Stop"
            :disabled="stopDisabled"
            @click="stopRun"
          >
            <Square :size="16" aria-hidden="true" />
          </button>

          <button
            id="send"
            type="submit"
            class="icon-button primary"
            aria-label="Send"
            title="Send"
            :disabled="isSendDisabled"
            v-show="!sendHidden"
          >
            <ArrowUp :size="18" aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>

    <ModelPicker @open="pickerOpen = true" @close="pickerOpen = false" />
  </div>
</template>

<style scoped>
.cron-context { display: flex; align-items: start; gap: 8px; margin-bottom: 8px; }
.cron-context > :first-child { flex: 1; }
.composer-att-item { display: inline-flex; align-items: center; position: relative; }
.composer-file-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 54px;
  padding: 0 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-width: 220px;
}
.composer-file-name {
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-file-size {
  font-size: 11px;
  color: var(--faint);
  flex: none;
}
.composer-uploading-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 54px;
  padding: 0 12px;
  background: var(--secondary);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--muted-foreground);
}
.composer-upload-error {
  margin: 6px 12px 0;
  font-size: 12px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>

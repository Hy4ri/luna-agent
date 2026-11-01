import { ref, computed, nextTick, type Ref } from "vue";
import type { MentionItem } from "@/lib/mention-sources";
import { searchMentions } from "@/lib/mention-sources";
import { matchAt, matchHash, matchSlash, type AutocompleteMatch } from "@/lib/composer-autocomplete";
import type { MentionCard, MentionGroup, SlashCommandItem, CommandGroup } from "./types";
import { filterAndSortMentionCards, groupMentionCards, filterSlashCommands, groupSlashCommands } from "./commands";
import { composer, saveDraft } from "@/stores/composer";
import type { chat as chatStore } from "@/stores/chat";

export function useComposerAutocomplete(options: {
  inputRef: Ref<HTMLTextAreaElement | null>;
  boardCards: Ref<MentionCard[]>;
  loadedPid: Ref<number | null>;
  activeProjectId: Ref<number | null>;
  mentionCardError: Ref<string>;
  fetchMentionCards: (pid: number | null, force?: boolean) => Promise<void>;
  grow: () => void;
  chat: typeof chatStore;
}) {
  const { inputRef, boardCards, loadedPid, activeProjectId, mentionCardError, fetchMentionCards, grow, chat } = options;

  const mentionMatch = ref<AutocompleteMatch | null>(null);
  const activeMentionIndex = ref(0);
  const commandMatch = ref<AutocompleteMatch | null>(null);
  const activeCommandIndex = ref(0);
  const atMatch = ref<AutocompleteMatch | null>(null);
  const activeAtIndex = ref(0);

  const sortedMentionItems = computed<MentionCard[]>(() => {
    if (!mentionMatch.value) return [];
    return filterAndSortMentionCards(boardCards.value, mentionMatch.value.query);
  });

  const mentionGroups = computed<MentionGroup[]>(() => groupMentionCards(sortedMentionItems.value));

  const mentionOpen = computed(() => !!mentionMatch.value && activeProjectId.value !== null && (sortedMentionItems.value.length > 0 || !!mentionCardError.value));

  const sortedCommandItems = computed<SlashCommandItem[]>(() => {
    if (!commandMatch.value) return [];
    return filterSlashCommands(commandMatch.value.query);
  });

  const commandGroups = computed<CommandGroup[]>(() => groupSlashCommands(sortedCommandItems.value));

  const commandOpen = computed(() => !mentionOpen.value && !!commandMatch.value && sortedCommandItems.value.length > 0);

  const atGroups = computed(() => {
    if (!atMatch.value) return [];
    let flatIndex = 0;
    return searchMentions(atMatch.value.query, {
      session: chat.session ? String(chat.session) : null,
      worker: chat.draftWorker,
      project: activeProjectId.value,
      cwd: chat.draftCwd,
    }).map(g => ({ id: g.source.id, label: g.source.label, items: g.items.map(item => ({ item, flatIndex: flatIndex++ })) }));
  });

  const atItems = computed<MentionItem[]>(() => atGroups.value.flatMap(g => g.items.map(e => e.item)));
  const atOpen = computed(() => !mentionOpen.value && !commandOpen.value && atItems.value.length > 0);

  function updateAtState() {
    const el = inputRef.value;
    if (!el) { atMatch.value = null; return; }
    const caret = el.selectionStart ?? el.value.length;
    const m = matchAt(el.value, caret);
    if (!m) { atMatch.value = null; return; }
    const prev = atMatch.value;
    atMatch.value = m;
    if (!prev || prev.query !== m.query) activeAtIndex.value = 0;
  }

  function selectAt(item: MentionItem) {
    const el = inputRef.value;
    const m = atMatch.value;
    if (!el || !m) return;
    const before = el.value.slice(0, m.start);
    const after = el.value.slice(m.end);
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
    const caret = el.selectionStart ?? el.value.length;
    const m = matchSlash(el.value, caret);
    if (!m) {
      commandMatch.value = null;
      return;
    }
    const prev = commandMatch.value;
    commandMatch.value = m;
    if (!prev || prev.query !== m.query) {
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

  function updateMentionState() {
    const el = inputRef.value;
    if (!el) {
      mentionMatch.value = null;
      return;
    }
    const caret = el.selectionStart ?? el.value.length;
    const m = matchHash(el.value, caret);
    if (!m || activeProjectId.value === null) {
      mentionMatch.value = null;
      return;
    }
    const prev = mentionMatch.value;
    mentionMatch.value = m;
    if (!prev || prev.start !== m.start) {
      void fetchMentionCards(activeProjectId.value, true);
    } else if (loadedPid.value !== activeProjectId.value || boardCards.value.length === 0) {
      void fetchMentionCards(activeProjectId.value, true);
    }
    if (!prev || prev.query !== m.query) {
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

  function clearMatches() {
    mentionMatch.value = null;
    commandMatch.value = null;
    atMatch.value = null;
  }

  return {
    mentionMatch,
    activeMentionIndex,
    commandMatch,
    activeCommandIndex,
    atMatch,
    activeAtIndex,
    sortedMentionItems,
    mentionGroups,
    mentionOpen,
    sortedCommandItems,
    commandGroups,
    commandOpen,
    atGroups,
    atItems,
    atOpen,
    updateAtState,
    selectAt,
    updateCommandState,
    selectCommand,
    updateMentionState,
    selectMention,
    clearMatches,
  };
}

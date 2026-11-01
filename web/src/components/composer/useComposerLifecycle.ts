import { watch, onMounted, onBeforeUnmount, nextTick, type Ref } from "vue";
import { addAttachment, captureAttachmentContext, restoreDraft, composer } from "@/stores/composer";
import { history, loadProjects } from "@/stores/sessions";
import { loadModels } from "@/stores/models";
import { boardChanged, focusInput } from "@/stores/app";
import { chat } from "@/stores/chat";

export function useComposerLifecycle(options: {
  inputRef: Ref<HTMLTextAreaElement | null>;
  activeProjectId: Ref<number | null>;
  fetchMentionCards: (pid: number | null, force?: boolean) => Promise<void>;
  grow: () => void;
  clearMatches: () => void;
  getMenuEls: () => (HTMLElement | null)[];
  fileRef: Ref<HTMLInputElement | null>;
  cameraRef: Ref<HTMLInputElement | null>;
}) {
  const { inputRef, activeProjectId, fetchMentionCards, grow, clearMatches, getMenuEls, fileRef, cameraRef } = options;

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

  function handleOutsideClick(e: MouseEvent) {
    const t = e.target as Node | null;
    const menuEls = getMenuEls();
    if (t && (inputRef.value?.contains(t) || menuEls.some(el => el?.contains(t)))) return;
    clearMatches();
  }

  watch(activeProjectId, (pid) => {
    void fetchMentionCards(pid, true);
  }, { immediate: true });

  watch(boardChanged, () => {
    if (activeProjectId.value !== null) void fetchMentionCards(activeProjectId.value, true);
  });

  watch(() => chat.session, () => {
    clearMatches();
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
      clearMatches();
    }
  });

  watch(() => focusInput.value, () => {
    nextTick(() => {
      inputRef.value?.focus();
    });
  });

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

  return {
    handleFileChange,
    handlePaste,
    handleDrop,
  };
}

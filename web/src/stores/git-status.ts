import { shallowRef, watch } from 'vue';
import { chat } from '@/stores/chat';
import { json, serverUrl, token } from '@/lib/api';
import type { GitStatus } from '../../../src/git-status';

export const gitStatus = shallowRef<GitStatus | null>(null);

let activeInstances = 0;
const visibleInstances = new Set<unknown>();

let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;
let generation = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void refreshGitStatus(); }, 100);
}

function isAnyVisible(): boolean {
  return visibleInstances.size > 0 && !document.hidden;
}

export async function refreshGitStatus() {
  if (!isAnyVisible() || !chat.session || !chat.connected || controller) return;

  const sid = chat.session;
  const epoch = chat.epoch;
  const own = generation;
  const request = new AbortController();
  controller = request;

  try {
    const result = await json<GitStatus>(`/v1/sessions/${sid}/git`, { signal: request.signal });
    if (own === generation && sid === chat.session && epoch === chat.epoch) {
      gitStatus.value = result;
    }
  } catch (e) {
    if (own === generation && !request.signal.aborted) {
      gitStatus.value = { state: 'error', message: (e as Error).message };
    }
  } finally {
    if (controller === request) {
      controller = undefined;
    }
  }
}

export function resetGitStatus() {
  generation++;
  controller?.abort();
  controller = undefined;
  gitStatus.value = null;
  scheduleRefresh();
}

// Wait for hydration and the atomic snapshot before reading the final execution target.
// Abort and fence on detach, session / cwd / machine / serverUrl changes.
watch([() => chat.session, () => chat.connected, () => chat.cwd, () => chat.machine?.id, serverUrl, token], resetGitStatus);

function onVisibilityChange() {
  if (document.hidden) {
    controller?.abort();
    controller = undefined;
  } else if (visibleInstances.size > 0) {
    scheduleRefresh();
  }
}

function onWindowFocus() {
  if (isAnyVisible()) {
    scheduleRefresh();
  }
}

function startPolling() {
  if (!timer) {
    timer = setInterval(refreshGitStatus, 5000);
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
    window.removeEventListener('focus', onWindowFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
}

/**
 * Register a GitStatus instance.
 * Call unregister when unmounted.
 */
export function registerGitStatusInstance(token: unknown) {
  activeInstances++;
  startPolling();

  return {
    setVisible(visible: boolean) {
      const prevAny = isAnyVisible();
      if (visible) {
        visibleInstances.add(token);
      } else {
        visibleInstances.delete(token);
      }
      const nowAny = isAnyVisible();
      if (!prevAny && nowAny) {
        scheduleRefresh();
      } else if (prevAny && !nowAny) {
        controller?.abort();
        controller = undefined;
      }
    },
    unregister() {
      visibleInstances.delete(token);
      activeInstances--;
      if (activeInstances <= 0) {
        activeInstances = 0;
        visibleInstances.clear();
        generation++;
        controller?.abort();
        controller = undefined;
        clearTimeout(refreshTimer); refreshTimer = undefined;
        stopPolling();
      }
    },
  };
}

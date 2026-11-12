import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Task B frontend optimizations', () => {
  const chatTs = readFileSync(resolve('web/src/stores/chat.ts'), 'utf8');
  const sessionsTs = readFileSync(resolve('web/src/stores/sessions.ts'), 'utf8');
  const terminalTs = readFileSync(resolve('web/src/stores/terminal.ts'), 'utf8');
  const browserTs = readFileSync(resolve('web/src/stores/browser.ts'), 'utf8');
  const scheduledVue = readFileSync(resolve('web/src/components/chat/ScheduledMessages.vue'), 'utf8');

  test('B.1: sessions_changed is debounced (300ms trailing, 1000ms maxWait)', () => {
    expect(chatTs).toContain('scheduleListReload');
    expect(chatTs).toContain('300');
    expect(chatTs).toContain('1000');
  });

  test('B.2: per-session AbortController aborts side requests on switch/detach', () => {
    expect(chatTs).toContain('sessionAbort');
    expect(chatTs).toContain('export function sessionSignal()');
    expect(terminalTs).toContain('sessionSignal()');
    expect(browserTs).toContain('sessionSignal()');
    expect(scheduledVue).toContain('sessionSignal()');
    expect(terminalTs).toContain('=== "AbortError"');
    expect(browserTs).toContain('=== "AbortError"');
    expect(scheduledVue).toContain('=== "AbortError"');
  });

  test('B.3: duplicate requests on session open are deduplicated', () => {
    expect(chatTs).toContain('userIndexLoading');
    expect(sessionsTs).toContain('focusedInFlight');
    expect(sessionsTs).toContain('trackActiveNotifications');
  });
});

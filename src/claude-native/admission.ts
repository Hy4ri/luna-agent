import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { NativeReplayMetadata, NativeSystemInjection } from './types.js';
export interface Block {
  type: string;
  [key: string]: unknown;
}

export class QueriedTurnMismatch extends Error {
  constructor(message = 'Native request does not match Luna host tool results') {
    super(message);
    this.name = 'QueriedTurnMismatch';
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== (b as unknown[]).length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], (b as unknown[])[i])) return false;
      }
      return true;
    }
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      const k = keysA[i]!;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

function _plain(block: unknown): unknown {
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    const copy = { ...(block as Record<string, unknown>) };
    delete copy.cache_control;
    return copy;
  }
  return block;
}

function _breakpoints(value: unknown): number {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node && typeof node === 'object') {
      if (Array.isArray(node)) {
        pending.push(...node);
      } else {
        const obj = node as Record<string, unknown>;
        if ('cache_control' in obj) count++;
        for (const [k, v] of Object.entries(obj)) {
          if (k !== 'cache_control') {
            pending.push(v);
          }
        }
      }
    }
  }
  return count;
}

function _frame_first(messages: any[], queried: Block[] | undefined): boolean {
  if (!queried || queried.length === 0) return false;
  if (messages.some(m => m.role === 'assistant')) return false;
  const first = messages.find(m => m.role === 'user');
  if (!first) return false;
  const content = first.content;
  if (!Array.isArray(content) || content.length <= queried.length) return false;
  const want = queried.map(b => _plain(b));
  const starts: number[] = [];
  for (let k = 0; k <= content.length - queried.length; k++) {
    const slice = content.slice(k, k + queried.length).map(b => _plain(b));
    if (deepEqual(slice, want)) {
      starts.push(k);
    }
  }
  if (starts.length !== 1 || starts[0] === 0) return false;
  const k = starts[0]!;
  if (!content.slice(0, k).every((b: any) => b && typeof b === 'object' && b.type === 'text')) return false;
  first.content = [...content.slice(k, k + queried.length), ...content.slice(0, k), ...content.slice(k + queried.length)];
  return true;
}

const _DATE_LINE = /^Today's date is \d{4}-\d{2}-\d{2}\.$/;

function withoutCacheControl(content: unknown): unknown {
  if (Array.isArray(content)) return content.map(withoutCacheControl);
  if (content && typeof content === 'object') {
    const copy = { ...(content as Record<string, unknown>) };
    delete copy.cache_control;
    return copy;
  }
  return content;
}

function setCacheBreakpoint(message: Record<string, unknown>): void {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (let k = content.length - 1; k >= 0; k--) {
    const block = content[k];
    if (block && typeof block === 'object' && !Array.isArray(block) && !UNCACHEABLE.includes(block.type)) {
      block.cache_control = { type: 'ephemeral', ttl: '1h' };
      return;
    }
  }
}

function setReplayCacheBreakpoints(messages: Array<Record<string, unknown>>): void {
  // Two message breakpoints plus one system and one tool breakpoint stay within Anthropic's limit.
  for (const message of messages) {
    delete message.cache_control;
    message.content = withoutCacheControl(message.content);
  }
  const userIndexes = messages
    .map((msg, idx) => (msg.role === 'user' ? idx : -1))
    .filter(idx => idx >= 0);
  if (userIndexes.length >= 2) setCacheBreakpoint(messages[userIndexes.at(-2)!]!);
  const final = messages.at(-1);
  if (final) setCacheBreakpoint(final);
}

function injectNativeSystemMessages(
  messages: Array<Record<string, unknown>>,
  injections: NativeSystemInjection[],
): Array<Record<string, unknown>> {
  const byAssistant = new Map<number, Array<Record<string, unknown>>>();
  const trailing: Array<Record<string, unknown>> = [];
  for (const injection of injections) {
    const message = { role: 'system', content: structuredClone(injection.content) };
    if (injection.beforeAssistant === null) trailing.push(message);
    else {
      const pending = byAssistant.get(injection.beforeAssistant) ?? [];
      pending.push(message);
      byAssistant.set(injection.beforeAssistant, pending);
    }
  }

  const output: Array<Record<string, unknown>> = [];
  let assistantOrdinal = 0;
  for (const message of messages) {
    if (message.role === 'assistant') {
      output.push(...(byAssistant.get(assistantOrdinal) ?? []));
      byAssistant.delete(assistantOrdinal);
      assistantOrdinal += 1;
    }
    output.push(message);
  }
  if (byAssistant.size > 0) throw new Error('Claude native request lost an assistant boundary needed by system history');
  output.push(...trailing);
  return output;
}

function normalizeLeadingSystemCache(system: unknown): void {
  if (!Array.isArray(system)) return;
  for (const block of system) {
    if (block && typeof block === 'object') delete (block as Record<string, unknown>).cache_control;
  }
  const last = system.at(-1);
  if (last && typeof last === 'object') {
    (last as Record<string, unknown>).cache_control = { type: 'ephemeral', ttl: '1h' };
  }
}

function applySystemInjections(payload: Buffer, injections?: NativeSystemInjection[]): Buffer {
  if (!injections) return payload;
  const body = JSON.parse(payload.toString('utf8'));
  if (!Array.isArray(body.messages)) throw new Error('Claude native request has no message list for tool history');
  // Never forward a request with silently missing tool removals or system updates.
  body.messages = injectNativeSystemMessages(body.messages, injections);
  normalizeLeadingSystemCache(body.system);
  setReplayCacheBreakpoints(body.messages);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function stableRequestContext(payload: Buffer, queried: Block[] | undefined): Buffer {
  try {
    const body = JSON.parse(payload.toString('utf8'));
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.every(m => m && typeof m === 'object')) {
      return payload;
    }
    for (const message of messages) {
      const content = message.content;
      if (!['system', 'user', 'assistant'].includes(message.role) || !(typeof content === 'string' || Array.isArray(content))) {
        return payload;
      }
      if (Array.isArray(content) && content.some(b => !b || typeof b !== 'object' || typeof b.type !== 'string' || (b.type === 'text' && typeof b.text !== 'string'))) {
        return payload;
      }
    }
    if (queried !== undefined && (!Array.isArray(queried) || queried.some(b => !b || typeof b !== 'object'))) {
      return payload;
    }
    let changed = false;
    const last = messages.length > 0 ? messages[messages.length - 1] : {};
    const env = messages.slice(0, -1).find(m => m.role === 'system');
    const content = last.content;
    const tail = typeof content === 'string' ? { type: 'text', text: content } : (Array.isArray(content) && content.length === 1 ? content[0] : {});
    if (last.role === 'system' && env !== undefined && tail && tail.type === 'text' && _DATE_LINE.test(tail.text || '')) {
      const original = env.content;
      const line = '\n\n' + tail.text;
      const target = typeof original === 'string' ? { type: 'text', text: original } : (Array.isArray(original) && original.length > 0 ? original[original.length - 1] : {});
      if (target && target.type === 'text' && !target.text?.endsWith(tail.text)) {
        if (typeof original === 'string') {
          env.content = original + line;
        } else if (Array.isArray(original) && original.length > 0) {
          target.text += line;
        }
        const mark = tail.cache_control !== undefined ? tail.cache_control : last.cache_control;
        messages.pop();
        const previous = messages.length > 0 ? messages[messages.length - 1].content : undefined;
        if (mark !== undefined && Array.isArray(previous) && previous.length > 0) {
          const lastPrev = previous[previous.length - 1];
          if (lastPrev && typeof lastPrev === 'object' && !('cache_control' in lastPrev)) {
            lastPrev.cache_control = mark;
          }
        }
        changed = true;
      }
    }
    const newest = [...messages].reverse().find(m => m.role === 'user') || {};
    const blocks = newest.content;
    if (queried && queried.length > 0 && queried.some(b => b.type !== 'tool_result') && Array.isArray(blocks) && messages.some(m => m.role === 'assistant')) {
      const frame = queried.map(b => _plain(b));
      const hits: number[] = [];
      for (let i = 0; i <= blocks.length - frame.length; i++) {
        if (deepEqual(blocks.slice(i, i + frame.length).map(b => _plain(b)), frame)) {
          hits.push(i);
        }
      }
      const k = hits.length === 1 ? hits[0] : undefined;
      if (k !== undefined && k > 0 && blocks.slice(0, k).every((b: any) => b && typeof b === 'object' && b.type === 'text' && Object.keys(b).every(key => ['type', 'text', 'cache_control'].includes(key)))) {
        const mark = blocks.slice(0, k).find((b: any) => b && 'cache_control' in b)?.cache_control;
        blocks.splice(0, k);
        if (mark !== undefined && blocks.length > 0) {
          const firstBlock = blocks[0];
          if (firstBlock && typeof firstBlock === 'object' && !('cache_control' in firstBlock)) {
            firstBlock.cache_control = mark;
          }
        }
        changed = true;
      }
    }
    return changed ? (Buffer.from(JSON.stringify(body), 'utf8') as unknown as Buffer) : payload;
  } catch {
    return payload;
  }
}

const UNCACHEABLE = ['thinking', 'redacted_thinking'];
const LOOKBACK = 20;
const MAX_BREAKPOINTS = 4;

function _opens_turn(message: any): boolean {
  const content = message.content;
  return message.role === 'user' && (typeof content === 'string' || (Array.isArray(content) && content.some(b => !b || typeof b !== 'object' || b.type !== 'tool_result')));
}

function _keep_turn_mark(body: any, messages: any[], last: number, target: [number, number, any]): boolean {
  let opening: number | undefined = undefined;
  for (let i = last - 1; i >= 0; i--) {
    if (_opens_turn(messages[i]!)) {
      opening = i;
      break;
    }
  }
  if (opening === undefined) return false;
  let thought: number | undefined = undefined;
  for (let i = opening + 1; i <= last; i++) {
    const m = messages[i];
    if (m && m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b && typeof b === 'object' && UNCACHEABLE.includes(b.type))) {
      thought = i;
      break;
    }
  }
  if (thought === undefined) return false;
  let frame = opening;
  for (let i = thought - 1; i > opening; i--) {
    if (messages[i]?.role === 'user') {
      frame = i;
      break;
    }
  }
  const content = messages[frame]?.content;
  if (!Array.isArray(content)) return false;
  let j: number | undefined = undefined;
  for (let k = content.length - 1; k >= 0; k--) {
    const b = content[k];
    if (b && typeof b === 'object' && !UNCACHEABLE.includes(b.type)) {
      j = k;
      break;
    }
  }
  if (j === undefined || 'cache_control' in content[j]! || frame > target[0] || (frame === target[0] && j >= target[1])) {
    return false;
  }
  let span = 0;
  for (let idx = frame; idx < target[0]; idx++) {
    const c = messages[idx]?.content;
    span += Array.isArray(c) ? c.length : 1;
  }
  if (span - j + target[1] + 1 <= LOOKBACK) return false;
  const marks: [number, number, any][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && Array.isArray(m.content)) {
      for (let k = 0; k < m.content.length; k++) {
        const b = m.content[k];
        if (b && typeof b === 'object' && 'cache_control' in b) {
          marks.push([i, k, b]);
        }
      }
    }
  }
  const later = marks.filter(([i, k]) => frame < i || (frame === i && j < k));
  if (later.length === 0) return false;
  if (_breakpoints(body) < MAX_BREAKPOINTS) {
    content[j].cache_control = JSON.parse(JSON.stringify(later[0]![2].cache_control));
    return true;
  }
  const spare = later.find(([i, k]) => i < target[0] || (i === target[0] && k < target[1]))?.[2];
  if (!spare || !('cache_control' in target[2])) return false;
  content[j].cache_control = spare.cache_control;
  delete spare.cache_control;
  return true;
}

/**
 * Keep the recurring message cache_control on content the next request replays unchanged (#14, #33, #122).
 * What recurs: everything through the last assistant message, plus the newest turn's leading blocks that equal
 * the frame Luna queried. Marks after that span fold onto its last cacheable block; content never changes.
 */
export function pinMessageBreakpoint(payload: Buffer, queried: Block[] | undefined): Buffer {
  if (!queried || queried.length === 0) return payload;
  try {
    const body = JSON.parse(payload.toString('utf8'));
    const messages: any[] = body.messages;
    const reordered = _frame_first(messages, queried);
    const blocks: [number, number, any][] = [];
    messages.forEach((m, i) => { if (Array.isArray(m.content)) m.content.forEach((b: any, j: number) => blocks.push([i, j, b])); });
    const marked = blocks.filter(([, , b]) => b && typeof b === 'object' && !Array.isArray(b) && 'cache_control' in b);
    if (marked.length === 0) return payload;
    let last = -1;
    messages.forEach((m, i) => { if (m.role === 'assistant') last = i; });
    const stable = blocks.filter(([i]) => i <= last);
    const newest = last + 1 < messages.length ? messages[last + 1] : {};
    if (newest.role === 'user' && Array.isArray(newest.content)) {
      const prefix: [number, number, any][] = [];
      for (let j = 0; j < Math.min(newest.content.length, queried.length); j++) {
        if (!deepEqual(_plain(newest.content[j]), _plain(queried[j]))) break;
        prefix.push([last + 1, j, newest.content[j]]);
      }
      // A breakpoint on unchanged results before a changed tool_result measured no hit (#33): stop at the assistant.
      const rest = newest.content.slice(prefix.length);
      if (!(rest.length && rest[0] && typeof rest[0] === 'object' && rest[0].type === 'tool_result')) stable.push(...prefix);
    }
    let target: [number, number, any] | undefined;
    for (let k = stable.length - 1; k >= 0; k--) {
      const b = stable[k]![2];
      if (b && typeof b === 'object' && !Array.isArray(b) && !UNCACHEABLE.includes(b.type)) { target = stable[k]; break; }
    }
    const after = target ? marked.filter(([i, j]) => target![0] < i || (target![0] === i && target![1] < j)).map(([, , b]) => b) : [];
    const folded = target !== undefined && after.length > 0;
    if (folded) {
      const moved = after.map(b => { const mark = b.cache_control; delete b.cache_control; return mark; })[0];
      if (!('cache_control' in target![2])) target![2].cache_control = moved;
    }
    const turn = target !== undefined && _keep_turn_mark(body, messages, last, target);
    if (!(reordered || folded || turn)) return payload;
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch {
    return payload;
  }
}

export function restoreQueriedTurn(payload: Buffer, queried: Block[] | undefined): Buffer {
  if (!Array.isArray(queried) || queried.length === 0) return payload;
  const strict = queried.some(block => block && typeof block === 'object' && block.type === 'tool_result');
  if (!strict) return payload;

  const unmatched = (): never => {
    throw new QueriedTurnMismatch();
  };

  const bareText = (block: unknown): boolean => {
    if (!block || typeof block !== 'object') return false;
    const keys = Object.keys(block).sort();
    return keys.length === 2 && keys[0] === 'text' && keys[1] === 'type' && (block as any).type === 'text' && typeof (block as any).text === 'string';
  };

  const restoreContent = (sent: unknown, host: unknown): unknown => {
    if (typeof host === 'string' || typeof sent === 'string') {
      const text = (value: unknown): string | null => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && value.every(b => bareText(b))) {
          return value.map((b: any) => b.text).join('');
        }
        return null;
      };
      const left = text(sent);
      const right = text(host);
      if (left === null || right === null || !left.startsWith(right)) return unmatched();
      return JSON.parse(JSON.stringify(host));
    }
    if (Array.isArray(sent) && Array.isArray(host)) {
      return restoreSequence(sent, host);
    }
    if (!deepEqual(sent, host)) return unmatched();
    return JSON.parse(JSON.stringify(host));
  };

  const restoreBlock = (sent: unknown, host: unknown): unknown => {
    if (!sent || typeof sent !== 'object' || !host || typeof host !== 'object') return unmatched();
    const restored = JSON.parse(JSON.stringify(host));
    const sObj = sent as Record<string, unknown>;
    const hObj = host as Record<string, unknown>;
    if (hObj.type === 'tool_result') {
      const leftError = sObj.is_error ?? false;
      const rightError = hObj.is_error ?? false;
      if (typeof leftError !== 'boolean' || typeof rightError !== 'boolean' || leftError !== rightError) {
        return unmatched();
      }
      const ignore = ['content', 'is_error', 'cache_control'];
      const f1 = Object.fromEntries(Object.entries(sObj).filter(([k]) => !ignore.includes(k)));
      const f2 = Object.fromEntries(Object.entries(hObj).filter(([k]) => !ignore.includes(k)));
      if (!deepEqual(f1, f2)) return unmatched();
      if (('content' in sObj) !== ('content' in hObj)) return unmatched();
      if ('content' in hObj) {
        restored.content = restoreContent(sObj.content, hObj.content);
      }
    } else if (!deepEqual(_plain(sent), _plain(host))) {
      return unmatched();
    }
    if ('cache_control' in sObj) {
      if ('cache_control' in hObj && !deepEqual(sObj.cache_control, hObj.cache_control)) {
        return unmatched();
      }
      restored.cache_control = JSON.parse(JSON.stringify(sObj.cache_control));
    }
    return restored;
  };

  const restoreSequence = (sent: unknown[], host: unknown[]): unknown[] => {
    const restored: unknown[] = [];
    let i = 0, j = 0;
    while (i < host.length) {
      if (j >= sent.length) return unmatched();
      const hBlock = host[i];
      const sBlock = sent[j];
      if (bareText(hBlock) && bareText(sBlock)) {
        let hostEnd = i + 1;
        while (hostEnd < host.length && bareText(host[hostEnd])) hostEnd++;
        let sentEnd = j + 1;
        while (sentEnd < sent.length && bareText(sent[sentEnd])) sentEnd++;
        const original = host.slice(i, hostEnd).map((b: any) => b.text).join('');
        const actual = sent.slice(j, sentEnd).map((b: any) => b.text).join('');
        const ok = hostEnd === host.length ? actual.startsWith(original) : actual === original;
        if (!ok) return unmatched();
        restored.push(...JSON.parse(JSON.stringify(host.slice(i, hostEnd))));
        i = hostEnd;
        j = sentEnd;
      } else {
        restored.push(restoreBlock(sBlock, hBlock));
        i++;
        j++;
      }
    }
    if (sent.slice(j).some(b => !bareText(b))) return unmatched();
    return restored;
  };

  try {
    const body = JSON.parse(payload.toString('utf8'));
    const messages = body.messages;
    if (!Array.isArray(messages)) return unmatched();
    let lastAssistant = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === 'assistant') lastAssistant = i;
    }
    const newest = lastAssistant + 1 < messages.length ? messages[lastAssistant + 1] : {};
    const native = newest && newest.role === 'user' ? newest.content : null;
    if (!Array.isArray(native)) return unmatched();

    const resultIds = queried
      .filter((b: any): b is Record<string, unknown> => !!b && typeof b === 'object' && b.type === 'tool_result')
      .map(b => b.tool_use_id);
    if (resultIds.some(id => typeof id !== 'string' || !id) || new Set(resultIds).size !== resultIds.length) {
      return unmatched();
    }
    const nativeIds = native
      .filter((b: any): b is Record<string, unknown> => !!b && typeof b === 'object' && b.type === 'tool_result')
      .map(b => b.tool_use_id);
    if (!deepEqual(resultIds, nativeIds)) return unmatched();

    const restored = restoreSequence(native, queried);
    if (deepEqual(native, restored)) return payload;
    newest.content = restored;
    return Buffer.from(JSON.stringify(body), 'utf8') as unknown as Buffer;
  } catch (err) {
    if (err instanceof QueriedTurnMismatch) throw err;
    return unmatched();
  }
}

export class Capture {
  message: Record<string, any> | undefined = undefined;
  complete = false;
  private pending = '';
  private decoder = new StringDecoder('utf8');
  private arguments: Record<number, string> = {};

  feed(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    const frames = this.pending.split(/\r?\n\r?\n/);
    this.pending = frames.pop() ?? '';
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^\s+/, ''));
        }
      }
      const data = dataLines.join('\n');
      if (data) {
        try {
          this.event(JSON.parse(data));
        } catch {}
      }
    }
  }

  private event(event: any): void {
    switch (event.type) {
      case 'message_start':
        this._start(event);
        break;
      case 'content_block_start':
        this._block_start(event);
        break;
      case 'content_block_delta':
        this._block_delta(event);
        break;
      case 'content_block_stop':
        this._block_stop(event);
        break;
      case 'message_delta':
        this._delta(event);
        break;
      case 'message_stop':
        this._stop(event);
        break;
    }
  }

  private _start(event: any): void {
    this.message = structuredClone(event.message);
  }

  private _block_start(event: any): void {
    if (this.message && Array.isArray(this.message.content)) {
      this.message.content.push(structuredClone(event.content_block));
    }
  }

  private _block_delta(event: any): void {
    if (!this.message || !Array.isArray(this.message.content)) return;
    const delta = event.delta;
    const block = this.message.content[event.index];
    if (!block) return;
    const map: Record<string, string> = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' };
    const field = map[delta.type];
    if (field) {
      block[field] = (block[field] || '') + delta[field];
    } else if (delta.type === 'input_json_delta') {
      const index = event.index;
      this.arguments[index] = (this.arguments[index] || '') + delta.partial_json;
    } else if (delta.type === 'citations_delta') {
      if (!Array.isArray(block.citations)) block.citations = [];
      block.citations.push(structuredClone(delta.citation));
    }
  }

  private _block_stop(event: any): void {
    const index = event.index;
    if (index in this.arguments && this.message && Array.isArray(this.message.content)) {
      const raw = this.arguments[index]!;
      delete this.arguments[index];
      const block = this.message.content[index];
      if (block) {
        try {
          block.input = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          block.input = {};
        }
      }
    }
  }

  private _delta(event: any): void {
    if (!this.message) return;
    if (event.delta) Object.assign(this.message, structuredClone(event.delta));
    if (event.usage) {
      if (!this.message.usage) this.message.usage = {};
      Object.assign(this.message.usage, structuredClone(event.usage));
    }
  }

  private _stop(_event: any): void {
    this.complete = Boolean(this.message && this.message.stop_reason && Object.keys(this.arguments).length === 0);
  }
}

export function upstreamProxy(upstream: URL, env: NodeJS.ProcessEnv = process.env): { host: string; port: number; headers?: Record<string, string> } | undefined {
  if (upstream.protocol !== 'https:') return undefined;
  const httpsVal = env.https_proxy || env.HTTPS_PROXY;
  const httpVal = env.http_proxy || env.HTTP_PROXY;
  let raw = httpsVal || httpVal;
  if (!raw) return undefined;

  const noProxy = env.no_proxy || env.NO_PROXY;
  if (noProxy) {
    const bypassList = noProxy.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const host = upstream.hostname;
    const port = upstream.port || '443';
    const hostPort = `${host}:${port}`;
    for (const entry of bypassList) {
      if (entry === '*') return undefined;
      if (entry === host || entry === hostPort) return undefined;
      if (entry.startsWith('.')) {
        if (host.endsWith(entry) || host === entry.slice(1)) return undefined;
      } else if (host.endsWith('.' + entry)) {
        return undefined;
      }
    }
  }

  if (!raw.includes('://')) raw = 'http://' + raw;
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(raw);
  } catch {
    return undefined;
  }
  if (proxyUrl.protocol !== 'http:') {
    console.warn('ignoring HTTPS_PROXY for the relay: only an http://host[:port] CONNECT proxy is supported; connecting directly');
    return undefined;
  }
  const hostname = proxyUrl.hostname;
  if (!hostname) return undefined;
  const port = proxyUrl.port ? parseInt(proxyUrl.port, 10) : 80;

  let headers: Record<string, string> | undefined = undefined;
  if (proxyUrl.username) {
    const creds = decodeURIComponent(proxyUrl.username) + ':' + decodeURIComponent(proxyUrl.password || '');
    headers = { 'Proxy-Authorization': 'Basic ' + Buffer.from(creds, 'utf8').toString('base64') };
  }
  return { host: hostname, port, headers };
}

export class UpstreamIdle extends Error {
  constructor(message = 'upstream idle timeout') {
    super(message);
    this.name = 'UpstreamIdle';
  }
}

export class Admission {
  readonly url: string;
  used = false;
  denied = 0;
  status: number | undefined = undefined;
  readonly limitHeaders: Record<string, string> = {};
  failure: string | undefined = undefined;
  requestId: string | undefined = undefined;
  unrestored: string | undefined = undefined;
  readonly capture = new Capture();
  errorBody = Buffer.alloc(0);

  private server: http.Server;
  private cancelled = false;
  private sockets = new Set<any>();
  private upstreamUrl: URL;
  private timeoutMs: number;
  private queried?: Block[];
  private replayMetadata?: NativeReplayMetadata;
  private proxy: ReturnType<typeof upstreamProxy>;

  private constructor(server: http.Server, url: string, upstream: URL, timeoutMs: number, queried?: Block[], replayMetadata?: NativeReplayMetadata) {
    this.server = server;
    this.url = url;
    this.upstreamUrl = upstream;
    this.timeoutMs = timeoutMs;
    this.queried = queried;
    this.replayMetadata = replayMetadata;
    this.proxy = upstreamProxy(upstream);

    this.server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
      if (err?.code === 'ECONNRESET' || err?.code === 'EPIPE') {
        socket.destroy();
        return;
      }
      socket.destroy();
    });

    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.setTimeout(this.timeoutMs);
      if (this.cancelled) socket.destroy();
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async open(upstream: string, timeoutMs: number, queried?: Block[], replayMetadata?: NativeReplayMetadata): Promise<Admission> {
    let u: URL;
    try {
      u = new URL(upstream);
    } catch {
      throw new Error('Native upstream must be HTTPS or a loopback HTTP fixture');
    }
    const host = u.hostname;
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host) || host.startsWith('127.');
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) || !host || u.username || u.password || u.search || u.hash) {
      throw new Error('Native upstream must be HTTPS or a loopback HTTP fixture');
    }

    const prefix = '/admit/' + randomBytes(32).toString('base64url');
    const server = http.createServer();

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });

    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}${prefix}`;

    const admission = new Admission(server, url, u, timeoutMs, queried, replayMetadata);
    server.on('request', (req, res) => admission.handleRequest(req, res, prefix));
    return admission;
  }

  errorText(): string {
    const text = this.errorBody.toString('utf8');
    try {
      const msg = JSON.parse(text).error?.message;
      if (typeof msg === 'string') return msg;
    } catch {}
    return text;
  }

  abort(): void {
    this.cancelled = true;
    for (const sock of this.sockets) {
      try {
        sock.destroy();
      } catch {}
    }
    this.sockets.clear();
  }

  async close(): Promise<void> {
    this.abort();
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, prefix: string): void {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method !== 'POST' || reqUrl.pathname !== prefix + '/v1/messages' || req.headers.origin) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (this.cancelled || this.used) {
      this.denied++;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      const body = Buffer.from('{"type":"error","error":{"type":"invalid_request_error","message":"LUNA_MODEL_ADMISSION_CONSUMED"}}', 'utf8');
      res.setHeader('Content-Length', body.length);
      res.end(body);
      return;
    }

    this.used = true;
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let payload: any = Buffer.concat(chunks);
      try {
        try {
          payload = restoreQueriedTurn(payload, this.queried);
        } catch (err: any) {
          this.unrestored = err.message;
          this.status = 400;
          this.failure = 'QueriedTurnMismatch';
          const errBody = Buffer.from('{"type":"error","error":{"type":"invalid_request_error","message":"Native request does not match Luna host tool results"}}', 'utf8');
          this.errorBody = errBody;
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Length', errBody.length);
          res.end(errBody);
          return;
        }

        payload = stableRequestContext(payload, this.queried);
        payload = applySystemInjections(payload, this.replayMetadata?.systemInjections);
        payload = pinMessageBreakpoint(payload, this.queried);

        const target = this.upstreamUrl;
        const route = target.pathname.replace(/\/$/, '') + '/v1/messages' + (reqUrl.search || '');

        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          if (!['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'accept-encoding'].includes(lk)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
          }
        }
        if (this.replayMetadata?.betas?.length) {
          const existing = headers['anthropic-beta'] ? headers['anthropic-beta'].split(',').map(s => s.trim()).filter(Boolean) : [];
          headers['anthropic-beta'] = [...new Set([...existing, ...this.replayMetadata.betas])].join(',');
        }
        headers['Accept-Encoding'] = 'identity';
        headers['Content-Length'] = String(payload.length);
        if (target.port) {
          headers['Host'] = target.hostname + ':' + target.port;
        } else {
          headers['Host'] = target.hostname;
        }

        let upstreamReq: http.ClientRequest;
        let proxySocket: any = null;

        if (target.protocol === 'https:') {
          if (this.proxy) {
            const { host: pHost, port: pPort, headers: pHeaders } = this.proxy;
            const targetHost = target.hostname;
            const targetPort = target.port ? parseInt(target.port, 10) : 443;

            await new Promise<void>((resolve, reject) => {
              const proxyReq = http.request({
                host: pHost,
                port: pPort,
                method: 'CONNECT',
                path: `${targetHost}:${targetPort}`,
                headers: pHeaders
              });
              proxyReq.on('connect', (res, socket) => {
                proxySocket = socket;
                if (res.statusCode !== 200) {
                  socket.destroy();
                  reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
                  return;
                }
                resolve();
              });
              proxyReq.on('error', reject);
              proxyReq.end();
            });

            const tlsSocket = tls.connect({
              socket: proxySocket,
              servername: target.hostname,
            });

            upstreamReq = https.request({
              hostname: target.hostname,
              port: targetPort,
              path: route,
              method: 'POST',
              headers,
              createConnection: () => tlsSocket
            });
          } else {
            upstreamReq = https.request({
              hostname: target.hostname,
              port: target.port ? parseInt(target.port, 10) : 443,
              path: route,
              method: 'POST',
              headers
            });
          }
        } else {
          upstreamReq = http.request({
            hostname: target.hostname,
            port: target.port ? parseInt(target.port, 10) : 80,
            path: route,
            method: 'POST',
            headers
          });
        }

        upstreamReq.on('socket', socket => {
          socket.setKeepAlive(true, 15000);
          this.sockets.add(socket);
        });

        upstreamReq.on('error', err => {
          this.failure ??= err.name || 'Error';
          // After headers, only a reset tells native the stream is cut; a dangling response would hang it.
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end();
          } else res.destroy();
        });

        upstreamReq.write(payload as any);
        upstreamReq.end();

        upstreamReq.on('response', proxyRes => {
          this.status = proxyRes.statusCode;
          for (const [name, value] of Object.entries(proxyRes.headers)) {
            if (typeof value === 'string' && (name.startsWith('anthropic-ratelimit-') || name === 'retry-after')) {
              this.limitHeaders[name] = value;
            }
          }
          this.requestId = (proxyRes.headers['request-id'] || proxyRes.headers['x-request-id']) as string | undefined;

          res.statusCode = proxyRes.statusCode || 200;
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            const lk = k.toLowerCase();
            if (!['connection', 'transfer-encoding', 'server', 'date'].includes(lk)) {
              if (v !== undefined) res.setHeader(k, v);
            }
          }
          res.setHeader('Connection', 'close');

          const idle = Math.min(this.timeoutMs, 180000);
          let idleTimer: NodeJS.Timeout;

          const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              this.failure = 'UpstreamIdle';
              upstreamReq.destroy(new UpstreamIdle());
            }, idle);
          };

          resetIdle();

          proxyRes.on('data', chunk => {
            resetIdle();
            if (proxyRes.statusCode === 200) {
              // A malformed SSE event leaves the capture incomplete; it must not throw out of an event handler.
              try { this.capture.feed(chunk as any); } catch (err) { this.failure ??= (err as Error).name || 'Error'; }
            } else if (this.errorBody.length < 65536) {
              this.errorBody = Buffer.concat([this.errorBody, chunk as any]);
            }
            res.write(chunk);
          });

          proxyRes.on('end', () => {
            clearTimeout(idleTimer);
            res.end();
          });

          proxyRes.on('error', err => {
            clearTimeout(idleTimer);
            this.failure = err.name || 'Error';
            res.destroy();
          });
        });

      } catch (err: any) {
        this.failure = err.name || 'Error';
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      }
    });
  }
}

// Adaptive, grapheme-safe text pacer for smooth 60/120fps streaming reveal.

const DEFAULT_TAU_MS = 130;
const MIN_CHARS_PER_MS = 1 / 22; // ~45 chars/s floor so small tails finish crisply
const MIN_DT_MS = 4;
const MAX_DT_MS = 50;

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function snapPrefixToBoundary(text: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= text.length) return text.length;
  if (graphemeSegmenter) {
    // Walk only a tiny window around `end` when possible; fallback to full prefix only if needed.
    const start = Math.max(0, end - 32);
    let lastBoundary = start;
    for (const seg of graphemeSegmenter.segment(text.slice(start, Math.min(text.length, end + 16)))) {
      const segEnd = start + seg.index + seg.segment.length;
      if (segEnd <= end) lastBoundary = segEnd;
      else break;
    }
    return lastBoundary;
  }
  if (isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
    return end - 1;
  }
  return end;
}

export class StreamPacer {
  private target = "";
  private displayedLength = 0;
  private carry = 0;

  constructor(private readonly tauMs = DEFAULT_TAU_MS) {}

  get displayed(): string {
    return this.target.slice(0, this.displayedLength);
  }

  get targetText(): string {
    return this.target;
  }

  get hasPending(): boolean {
    return this.displayedLength < this.target.length;
  }

  reset(): void {
    this.target = "";
    this.displayedLength = 0;
    this.carry = 0;
  }

  flush(): string {
    this.displayedLength = this.target.length;
    this.carry = 0;
    return this.target;
  }

  /**
   * Updates the target string. Returns true if `displayed` changed immediately
   * (either because `immediate` was requested or because the prefix diverged).
   */
  setTarget(next: string, immediate = false): boolean {
    const wasIdle = !this.hasPending;
    if (immediate) {
      const prevDisplayed = this.displayed;
      this.target = next;
      this.displayedLength = next.length;
      this.carry = 0;
      return prevDisplayed !== next;
    }

    let changed = false;
    if (this.displayedLength > 0) {
      const shown = this.target.slice(0, this.displayedLength);
      if (!next.startsWith(shown)) {
        let common = 0;
        const limit = Math.min(shown.length, next.length);
        while (common < limit && shown.charCodeAt(common) === next.charCodeAt(common)) common++;
        this.displayedLength = snapPrefixToBoundary(next, common);
        changed = this.displayedLength !== shown.length;
      }
    }

    this.target = next;
    if (wasIdle && this.hasPending) {
      // Seed carry so the first frame after new data arrives advances immediately.
      this.carry = Math.max(this.carry, 1);
    }
    return changed;
  }

  /**
   * Advances displayed text for a frame delta `dtMs`. Returns the updated displayed
   * string when characters were revealed, or `null` if nothing changed.
   */
  step(dtMs: number): string | null {
    const remaining = this.target.length - this.displayedLength;
    if (remaining <= 0) {
      this.carry = 0;
      return null;
    }

    const dt = Math.max(MIN_DT_MS, Math.min(MAX_DT_MS, Number.isFinite(dtMs) ? dtMs : 16.67));
    const rate = Math.max(remaining / this.tauMs, MIN_CHARS_PER_MS);
    this.carry += rate * dt;
    const approxChars = Math.floor(this.carry);
    if (approxChars < 1) return null;
    this.carry = Math.min(1, this.carry - approxChars);

    let nextEnd = this.displayedLength;
    if (graphemeSegmenter) {
      const windowEnd = Math.min(this.target.length, this.displayedLength + approxChars * 4 + 32);
      const tail = this.target.slice(this.displayedLength, windowEnd);
      for (const seg of graphemeSegmenter.segment(tail)) {
        nextEnd = this.displayedLength + seg.index + seg.segment.length;
        if (nextEnd - this.displayedLength >= approxChars) break;
      }
      if (nextEnd === this.displayedLength) {
        for (const seg of graphemeSegmenter.segment(this.target.slice(this.displayedLength))) {
          nextEnd = this.displayedLength + seg.index + seg.segment.length;
          if (nextEnd - this.displayedLength >= approxChars) break;
        }
      }
    } else {
      nextEnd = Math.min(this.target.length, this.displayedLength + approxChars);
      if (nextEnd < this.target.length && isHighSurrogate(this.target.charCodeAt(nextEnd - 1)) && isLowSurrogate(this.target.charCodeAt(nextEnd))) {
        nextEnd++;
      }
    }

    if (nextEnd <= this.displayedLength) nextEnd = this.target.length;
    this.displayedLength = nextEnd;
    if (!this.hasPending) this.carry = 0;
    return this.displayed;
  }
}

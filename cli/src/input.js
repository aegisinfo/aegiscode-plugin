'use strict';

/**
 * Line editor with history — the input line's buffer, cursor and recall.
 *
 * Ported from `aegiscodex-dev/src/input.js`. The one thing worth knowing before
 * touching it: `cursor` is a **codepoint** index, not a UTF-16 index. Slicing
 * `buf` directly corrupts a surrogate pair the moment one has been inserted
 * (the next insert's slice lands mid-pair and leaves a lone surrogate, which
 * renders as U+FFFD), so every mutation splices on `[...buf]` instead.
 */

class LineEditor {
  constructor() {
    this.buf = '';
    this.cursor = 0;
    this.history = [];
    this.hi = -1;
    this.draft = '';
  }

  reset() {
    this.buf = '';
    this.cursor = 0;
    this.hi = -1;
    this.draft = '';
  }

  insert(ch) {
    const arr = [...this.buf];
    arr.splice(this.cursor, 0, ...ch);
    this.buf = arr.join('');
    this.cursor += [...ch].length;
  }

  left() {
    if (this.cursor > 0) this.cursor--;
  }

  right() {
    if (this.cursor < [...this.buf].length) this.cursor++;
  }

  home() {
    this.cursor = 0;
  }

  end() {
    this.cursor = [...this.buf].length;
  }

  backspace() {
    if (this.cursor === 0) return;
    const arr = [...this.buf];
    arr.splice(this.cursor - 1, 1);
    this.buf = arr.join('');
    this.cursor--;
  }

  delete() {
    if (this.cursor >= [...this.buf].length) return;
    const arr = [...this.buf];
    arr.splice(this.cursor, 1);
    this.buf = arr.join('');
  }

  /** vim `s` — delete the char under the cursor (caller switches to insert). */
  substChar() {
    if (this.cursor >= [...this.buf].length) return false;
    this.delete();
    return true;
  }

  /** vim `S` — clear the whole line (caller switches to insert). */
  substLine() {
    const had = this.buf.length > 0;
    this.buf = '';
    this.cursor = 0;
    return had;
  }

  killToEnd() {
    this.buf = [...this.buf].slice(0, this.cursor).join('');
  }

  wordBack() {
    const arr = [...this.buf];
    let i = this.cursor;
    while (i > 0 && arr[i - 1] === ' ') i--;
    while (i > 0 && arr[i - 1] !== ' ') i--;
    this.cursor = i;
  }

  wordDelete() {
    const arr = [...this.buf];
    let i = this.cursor;
    while (i < arr.length && arr[i] === ' ') i++;
    while (i < arr.length && arr[i] !== ' ') i++;
    this.buf = arr.slice(0, this.cursor).join('') + arr.slice(i).join('');
  }

  historyUp() {
    if (!this.history.length) return;
    if (this.hi === -1) {
      this.draft = this.buf;
      this.hi = this.history.length - 1;
    } else if (this.hi > 0) this.hi--;
    this.buf = this.history[this.hi];
    this.end();
  }

  historyDown() {
    if (this.hi === -1) return;
    if (this.hi < this.history.length - 1) {
      this.hi++;
      this.buf = this.history[this.hi];
    } else {
      this.hi = -1;
      this.buf = this.draft;
    }
    this.end();
  }

  /** Commit the buffer. Returns the trimmed text and clears the line, or null
   *  when there was nothing to submit (a bare Enter must not become a turn). */
  submit() {
    const text = this.buf.trim();
    if (!text) return null;
    this.history.push(text);
    if (this.history.length > 500) this.history.shift();
    this.reset();
    return text;
  }
}

module.exports = { LineEditor };

'use strict';

/**
 * Transcript → markdown/json export for /export, and the last-response
 * extraction for /copy. Exports are written to the current directory (or the
 * clipboard) and the resulting path is reported in the transcript.
 *
 * Ported from aegiscodex-dev/src/export.js (ESM → CommonJS). Output strings
 * (the # Aegiscodex session header, the ## Claude / ## User role headers, the
 * aegiscodex-export- filename) are kept as in the reference.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Render the transcript as a markdown document. */
function transcriptToMarkdown(transcript) {
  const lines = ['# Aegiscodex session', '', `> exported ${new Date().toISOString()}`, ''];
  for (const m of transcript) {
    const text = (m.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (m.role === 'user') lines.push(`## User\n\n${text || '_(empty)_'}`, '');
    else if (m.role === 'assistant') lines.push(`## Claude\n\n${text || '_(empty)_'}`, '');
    else if (m.role === 'note') lines.push(`> ${text}`, '');
  }
  return lines.join('\n');
}

/** Render the transcript as a JSON document (array of messages). */
function transcriptToJSON(transcript) {
  const clean = transcript.map((m) => ({
    role: m.role,
    text: m.text || '',
    ...(m.tool ? { tool: m.tool } : {}),
  }));
  return JSON.stringify(clean, null, 2);
}

/**
 * Write exported text to a file. target: absolute path, 'clipboard' handled by
 * the caller (clipboard.js) — here we only do files.
 * Returns the absolute path written.
 */
function writeExportFile(text, format, cwd = process.cwd()) {
  const ext = format === 'json' ? 'json' : 'md';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `aegiscodex-export-${ts}.${ext}`;
  const p = path.join(cwd, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** The most recent assistant response (last N when given a count). */
function lastAssistantText(transcript, count = 1) {
  const asst = transcript.filter((m) => m.role === 'assistant');
  const n = Math.max(1, Math.min(count, asst.length));
  return asst.slice(asst.length - n).map((m) => m.text || '').join('\n\n');
}

module.exports = {
  transcriptToMarkdown,
  transcriptToJSON,
  writeExportFile,
  lastAssistantText,
};

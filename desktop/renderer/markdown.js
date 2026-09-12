'use strict';

/**
 * Assistant-message markdown rendering: marked -> DOMPurify -> DOM
 * postprocessing (syntax highlight + copy buttons on fenced code, external
 * link rewiring). This is the ONLY path that may put model output into
 * innerHTML — everywhere else in app.js, assistant/user text stays
 * textContent. See renderInto() below.
 *
 * Loaded as a classic script (CSP script-src 'self', no bundler) after
 * vendor/marked.umd.js, vendor/purify.min.js and vendor/aegis-highlight.js
 * (all under renderer/vendor/ — desktop/vendor/ is a predist.mjs staging
 * dir that the repo's pre-commit hook blocks from ever being committed),
 * before app.js. Exposes window.AegisMarkdown.
 *
 * UMD-lite like aegis-highlight.js: CommonJS export for the pure, DOM-free
 * helpers so they're unit-testable in plain Node; the DOM-dependent half
 * (renderInto) only runs under a real document (Electron renderer).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.AegisMarkdown = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Is `href` an absolute http(s) URL — something that could plausibly be
   * opened externally? Deliberately parsed with NO base: a relative path or
   * bare "#anchor" has no scheme and must fail to parse here, not silently
   * inherit https: from a placeholder base (that was the original bug —
   * every relative href came back "external"). This is defense in depth
   * only — main.js's isSafeExternalUrl is the real gate before anything
   * reaches the OS shell.
   */
  function isExternalHref(href) {
    if (typeof href !== 'string' || !href) return false;
    try {
      const url = new URL(href);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** "language-js" -> "js"; "" for a code block with no fence language. */
  function langFromClassName(className) {
    const m = /language-([\w-]+)/.exec(className || '');
    return m ? m[1] : '';
  }

  let markedConfigured = false;
  function configureMarked(marked) {
    if (markedConfigured) return;
    marked.setOptions({ gfm: true, breaks: false });
    markedConfigured = true;
  }

  /** Markdown -> raw (unsanitized) HTML, or null if marked isn't loaded —
   *  callers must treat null as "render as plain text", never as HTML. */
  function toHtml(markdownText) {
    const marked = typeof window !== 'undefined' ? window.marked : null;
    if (!marked || typeof marked.parse !== 'function') return null;
    configureMarked(marked);
    return marked.parse(markdownText == null ? '' : String(markdownText));
  }

  /** Raw HTML -> sanitized HTML, or null if DOMPurify isn't loaded/ready. */
  function sanitize(html) {
    const DOMPurify = typeof window !== 'undefined' ? window.DOMPurify : null;
    if (!DOMPurify || typeof DOMPurify.sanitize !== 'function') return null;
    return DOMPurify.sanitize(html, {
      // Restrict link/media URIs to what isExternalHref()/rewireLinks()
      // actually know how to handle; javascript:/data:/file:/mailto: etc.
      // never survive (mailto has no OS-shell path through openExternal,
      // which only allows http/https — see main.js isSafeExternalUrl).
      ALLOWED_URI_REGEXP: /^(?:https?:|#)/i,
    });
  }

  /**
   * Highlight + add a copy button to one fenced-code `<pre>`. Runs on the
   * live sanitized DOM, reading the code's real text (already unescaped by
   * the browser's own HTML parsing) and replacing it with our own
   * self-escaping highlighter output — never re-feeding anything through
   * innerHTML that didn't originate from AegisHighlight.escapeHtml.
   */
  function decorateCodeBlock(preEl) {
    const codeEl = preEl.querySelector('code');
    if (!codeEl) return;
    const lang = langFromClassName(codeEl.className);
    const raw = codeEl.textContent || '';
    const AegisHighlight = typeof window !== 'undefined' ? window.AegisHighlight : null;
    if (AegisHighlight) {
      codeEl.innerHTML = AegisHighlight.highlight(raw, lang);
    }
    preEl.classList.add('code-block');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(raw).then(
        () => {
          btn.textContent = 'copied!';
          setTimeout(() => { btn.textContent = 'copy'; }, 1500);
        },
        () => {
          btn.textContent = 'copy failed';
          setTimeout(() => { btn.textContent = 'copy'; }, 1500);
        }
      );
    });
    preEl.appendChild(btn);
  }

  /**
   * Every link in rendered markdown opens in the OS default browser via the
   * aegis.openExternal IPC bridge, never as in-app navigation (a stray
   * `<a href>` reaching BrowserWindow's default handler would point the
   * chat UI itself at an arbitrary model-supplied origin).
   */
  function rewireLinks(container) {
    const aegis = typeof window !== 'undefined' ? window.aegis : null;
    const links = container.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href');
      a.removeAttribute('target');
      a.setAttribute('rel', 'noopener noreferrer');
      if (!isExternalHref(href)) {
        // Not absolute http(s) (e.g. an in-page "#" anchor) — strip the
        // href outright rather than let it fall through to default
        // navigation inside the app's own BrowserWindow.
        a.removeAttribute('href');
        continue;
      }
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (aegis && typeof aegis.openExternal === 'function') aegis.openExternal(href);
      });
    }
  }

  /**
   * Render `markdownText` into `containerEl`, replacing its contents.
   * Always sanitized; falls back to a plain-text node (never raw innerHTML)
   * when marked or DOMPurify failed to load. This is the only function in
   * the renderer allowed to put model output into innerHTML.
   */
  function renderInto(containerEl, markdownText) {
    const html = toHtml(markdownText);
    const safe = html == null ? null : sanitize(html);
    if (safe == null) {
      containerEl.textContent = markdownText == null ? '' : String(markdownText);
      return;
    }
    containerEl.innerHTML = safe;
    for (const pre of containerEl.querySelectorAll('pre')) decorateCodeBlock(pre);
    rewireLinks(containerEl);
  }

  return { renderInto, isExternalHref, langFromClassName };
});

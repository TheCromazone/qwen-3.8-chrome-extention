// Injected into the page to build a snapshot. Everything here runs in the page,
// so it must be self-contained.
export function pageSnapshot() {
  const CONSEQUENTIAL = /\b(place order|buy now|pay|purchase|checkout now|send|post|publish|delete|remove|confirm|submit order)\b/i;

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.textContent.trim()) return lbl.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const text = [...wrapping.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(' ')
        .trim();
      if (text) return text;
    }
    const own = (el.textContent ?? '').trim();
    if (own) return own.replace(/\s+/g, ' ').slice(0, 120);
    return el.getAttribute('placeholder')?.trim() || el.getAttribute('name')?.trim() || '';
  };

  const role = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'password') return 'password';
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return el.getAttribute('role') || 'generic';
  };

  // ---- interactive element index, with stable refs ------------------------
  const selector = 'a[href], button, input, select, textarea, [role="button"], [onclick]';
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    const name = accessibleName(el);
    if (!name && role(el) !== 'password') continue;
    const ref = String(++n);
    el.setAttribute('data-qwen-ref', ref);
    const r = role(el);
    const bits = [`[${ref}] ${r} ${JSON.stringify(name)}`];
    if (el.tagName === 'A' && el.href) bits.push(`href=${el.href}`);
    if (r === 'password') bits.push('sensitive=true');
    if (CONSEQUENTIAL.test(name)) bits.push('consequential=true');
    lines.push(bits.join(' '));
  }

  // ---- readable text, with site adapters where the generic path fails -----
  const host = location.hostname;
  let text = '';
  let adapter = 'generic';


  const kix = document.querySelectorAll('.kix-lineview-text-block');
  if (kix.length) {
    adapter = 'google-docs';
    const title = document.querySelector('#docs-title-input-label-inner')?.textContent?.trim() ?? document.title;
    text = `Document: ${title}\n\n` + [...kix].map((s) => s.textContent.trim()).filter(Boolean).join('\n');
  }

  if (!text) {
    const clone = document.body.cloneNode(true);
    for (const junk of clone.querySelectorAll('script, style, noscript')) junk.remove();
    // No slicing. Truncating here is the single most common way a page
    // assistant silently loses the answer.
    text = (clone.innerText ?? clone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Tables read badly as bare text; keep the header/value pairing.
  const tables = [...document.querySelectorAll('table')].map((t) =>
    [...t.rows].map((r) => [...r.cells].map((c) => c.textContent.trim()).join(': ')).join('\n')
  );
  if (tables.length) text += '\n\n' + tables.join('\n\n');

  return { title: document.title, url: location.href, text, index: lines.join('\n'), adapter };
}

export function actOnPage(action) {
  const el = action.ref != null ? document.querySelector(`[data-qwen-ref="${CSS.escape(String(action.ref))}"]`) : null;
  if (!el) return { ok: false, observation: `no element for ref ${action.ref}` };

  const label = el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 80) || el.name || '';

  if (action.type === 'click') {
    el.click();
    return { ok: true, observation: `clicked ${el.tagName.toLowerCase()} ${JSON.stringify(label)}` };
  }
  if (action.type === 'type') {
    el.focus();
    el.value = action.value ?? '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, observation: `typed ${JSON.stringify(action.value ?? '')} into ${JSON.stringify(label)}` };
  }
  if (action.type === 'submit') {
    (el.form ?? el.closest('form'))?.submit();
    return { ok: true, observation: `submitted the form at ${JSON.stringify(label)}` };
  }
  return { ok: false, observation: `unsupported action ${action.type}` };
}

/** Is this ref a password field, and where would clicking it send us? */
export function inspectRef(ref) {
  const el = document.querySelector(`[data-qwen-ref="${CSS.escape(String(ref))}"]`);
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    href: el.tagName === 'A' ? el.href : null,
    label: el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 80) || el.getAttribute('name') || ''
  };
}

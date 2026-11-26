// Tiny DOM helpers. Text only ever goes in through textContent, never
// innerHTML, so nothing from an envelope or vault can inject markup.
// No inline style attributes: the CSP allows only the hashed stylesheet.

/**
 * h('div', { class: 'card', on: { click: fn }, attrs: { 'aria-label': 'x' } }, 'text', child)
 * Recognised props: class, text, on, attrs, value, type, id, and any other
 * plain DOM property (disabled, checked, placeholder, ...).
 */
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'class') e.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) e.setAttribute(a, String(av));
    else if (k === 'style') throw new Error('inline styles are blocked by the CSP; use a class');
    else e[k] = v;
  }
  append(e, kids);
  return e;
}

function append(e, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...kids) {
  clear(node);
  append(node, kids);
  return node;
}

/** Render summary segments [{text, strong}] from core/describe.js. */
export function segments(list) {
  return list.map((s) => (s.strong ? h('strong', { text: s.text }) : document.createTextNode(s.text)));
}

/** A secret text input: no autocomplete, spellcheck or autocapitalise (A17). */
export function secretInput(props = {}) {
  const e = h('input', { type: 'password', class: 'secret', ...props });
  e.setAttribute('autocomplete', 'off');
  e.setAttribute('spellcheck', 'false');
  e.setAttribute('autocapitalize', 'off');
  e.setAttribute('autocorrect', 'off');
  e.dataset.secret = '1';
  return e;
}

/** A plain text input with the same no-autofill settings. */
export function textInput(props = {}) {
  const e = h('input', { type: 'text', ...props });
  e.setAttribute('autocomplete', 'off');
  e.setAttribute('spellcheck', 'false');
  e.setAttribute('autocapitalize', 'off');
  return e;
}

export const sleepFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

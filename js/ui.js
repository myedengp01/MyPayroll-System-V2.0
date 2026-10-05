// MyPayroll-System-V2.0 · ui.js — small DOM helpers (no framework)

/** h('div', {class:'x', onclick:fn}, child, 'text', [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;            // only ever used with trusted, static markup
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(message, type = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type === 'error' ? 'error' : ''}`, role: type === 'error' ? 'alert' : 'status' }, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Report a Supabase error in plain words. Returns true if there was an error. */
export function failed(error, action = 'Save') {
  if (!error) return false;
  let msg = error.message || String(error);
  if (/row-level security|permission denied/i.test(msg)) msg = 'Your role does not allow this change.';
  if (/duplicate key/i.test(msg)) msg = 'That code or name already exists.';
  toast(`${action} failed: ${msg}`, 'error', 6000);
  return true;
}

/**
 * openModal({title, body: Node, actions:[{label, primary, danger, onClick(close) -> bool|Promise}] , wide})
 * Returns close().
 */
export function openModal({ title, body, actions = [], wide = false, onClose }) {
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    backdrop.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const foot = h('div', { class: 'modal-foot' },
    h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'),
    actions.map((a) => {
      const b = h('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, type: 'button' }, a.label);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { const keepOpen = await a.onClick(close); if (keepOpen === false) return; }
        finally { b.disabled = false; }
      });
      return b;
    }));
  const modal = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title),
      h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body), foot);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, modal);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  (modal.querySelector('input, select, textarea') || modal.querySelector('.btn.primary'))?.focus();
  return close;
}

export function confirmDialog(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title, body: h('p', {}, message), onClose: () => resolve(ok),
      actions: [{ label: confirmLabel, primary: !danger, danger, onClick: (c) => { ok = true; c(); } }],
    });
  });
}

/** Labeled input builder. type: text|number|date|email|select|textarea|switch */
export function field(label, { type = 'text', value = '', options = [], required = false, placeholder = '', span2 = false, step, min, hint } = {}) {
  let input;
  if (type === 'select') {
    input = h('select', { required },
      options.map((o) => {
        const [val, lab] = Array.isArray(o) ? o : [o, o];
        return h('option', { value: val, selected: String(val) === String(value ?? '') }, lab);
      }));
  } else if (type === 'textarea') {
    input = h('textarea', { required, placeholder }); input.value = value ?? '';
  } else if (type === 'switch') {
    input = h('input', { type: 'checkbox' }); input.checked = !!value;
    const wrap = h('label', { class: `check-row ${span2 ? 'span-2' : ''}` }, h('span', { class: 'switch' }, input, h('span', {})), label);
    wrap.input = input; wrap.getValue = () => input.checked; return wrap;
  } else {
    input = h('input', { type, required, placeholder, step, min }); input.value = value ?? '';
  }
  const wrap = h('label', { class: `field ${span2 ? 'span-2' : ''}` }, label, input, hint ? h('span', { class: 'small muted' }, hint) : null);
  wrap.input = input;
  wrap.getValue = () => {
    if (type === 'number') return input.value === '' ? null : Number(input.value);
    const v = input.value.trim();
    return v === '' ? null : v;
  };
  return wrap;
}

export function switchToggle(checked, onChange, { disabled = false, label = '' } = {}) {
  const input = h('input', { type: 'checkbox', 'aria-label': label, disabled });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', {}));
}

export const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  return x.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const money = (n) => (n === null || n === undefined || n === '' ? '' :
  Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function pageHead(title, description, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), description ? h('p', {}, description) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export function logoTile(company, extraClass = '') {
  if (company?.logo) return h('div', { class: `logo-tile ${extraClass}` }, h('img', { src: company.logo, alt: `${company.name} logo` }));
  return h('div', { class: `logo-tile empty ${extraClass}`, title: company ? `${company.name}: no logo yet` : '' },
    company?.short_name || company?.code || '');
}

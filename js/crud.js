// MyPayroll-System-V2.0 · crud.js — reusable list + edit-modal panel for simple tables
import { h, clear, openModal, confirmDialog, field, switchToggle, toast, failed, fmtDate } from './ui.js';

const getVal = (row, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), row);

/**
 * cfg = {
 *   table, title, description, writeRoles, filter:{col:value}, order:[[col, asc]],
 *   columns:[{ key, label, type:'text'|'number'|'date'|'select'|'switch', options, required,
 *              hint, list:true|false, form:true|false, render(row), default }],
 *   addLabel, emptyText, allowDelete, onChange()
 * }
 */
export async function crudPanel(container, ctx, cfg) {
  const canWrite = ctx.can(cfg.writeRoles || ['admin']);
  const body = h('div', { class: 'table-wrap' });
  const addBtn = canWrite ? h('button', { class: 'btn primary sm', type: 'button', onclick: () => edit(null) }, cfg.addLabel || 'Add') : null;
  const panel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('div', {}, h('h2', {}, cfg.title), cfg.description ? h('p', { class: 'small muted' }, cfg.description) : null),
      addBtn),
    body);
  container.append(panel);

  let rows = [];
  async function load() {
    let q = ctx.sb.from(cfg.table).select('*');
    for (const [k, v] of Object.entries(cfg.filter || {})) q = q.eq(k, v);
    for (const [col, asc] of cfg.order || [['sort_order', true], ['id', true]]) q = q.order(col, { ascending: asc });
    const { data, error } = await q;
    if (failed(error, 'Load')) return;
    rows = data || [];
    draw();
  }

  function draw() {
    clear(body);
    if (!rows.length) {
      body.append(h('div', { class: 'empty-state' }, h('p', {}, cfg.emptyText || 'Nothing here yet.'),
        canWrite ? h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, cfg.addLabel || 'Add') : null));
      return;
    }
    const cols = cfg.columns.filter((c) => c.list !== false);
    const table = h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.type === 'number' ? 'num' : '' }, c.label)), canWrite ? h('th', {}) : null)),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.is_active === false ? 'inactive' : '' },
        cols.map((c) => h('td', { class: c.type === 'number' ? 'num' : '' }, cell(r, c))),
        canWrite ? h('td', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r) }, 'Edit'),
          cfg.allowDelete !== false ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => remove(r) }, 'Delete') : null) : null))));
    body.append(table);
  }

  function cell(r, c) {
    if (c.render) return c.render(r);
    const v = getVal(r, c.key);
    if (c.type === 'switch') {
      if (!canWrite) return v ? 'Yes' : 'No';
      return switchToggle(v, async (checked, input) => {
        const patch = { [c.key]: checked };
        const { error } = await ctx.sb.from(cfg.table).update(patch).eq('id', r.id);
        if (failed(error)) { input.checked = !checked; return; }
        r[c.key] = checked; draw(); cfg.onChange?.();
      }, { label: `${c.label} for ${r.name || r.label || r.code}` });
    }
    if (c.type === 'date') return fmtDate(v);
    if (c.type === 'select' && c.options) {
      const opt = c.options.find((o) => String(Array.isArray(o) ? o[0] : o) === String(v ?? ''));
      return opt ? (Array.isArray(opt) ? opt[1] : opt) : (v ?? '');
    }
    return v ?? '';
  }

  function edit(row) {
    const formCols = cfg.columns.filter((c) => c.form !== false);
    const fields = formCols.map((c) => {
      const value = row ? getVal(row, c.key) : (typeof c.default === 'function' ? c.default() : c.default);
      return { c, f: field(c.label, { type: c.type || 'text', value, options: c.options, required: c.required, hint: c.hint, span2: c.span2, step: c.step }) };
    });
    openModal({
      title: row ? `Edit ${cfg.itemName || 'item'}` : (cfg.addLabel || 'Add'),
      body: h('div', { class: 'form-grid' }, fields.map((x) => x.f)),
      actions: [{
        label: row ? 'Save changes' : 'Add', primary: true,
        onClick: async (close) => {
          const rec = { ...(cfg.filter || {}) };
          for (const { c, f } of fields) {
            const v = f.getValue();
            if (c.required && (v === null || v === '')) { toast(`${c.label} is required.`, 'error'); return false; }
            if (c.key.includes('.')) {           // nested JSON, e.g. meta.stat_class
              const [root, sub] = c.key.split('.');
              rec[root] = { ...(row?.[root] || {}), ...(rec[root] || {}), [sub]: v };
            } else rec[c.key] = v;
          }
          if (cfg.beforeSave) cfg.beforeSave(rec, row);
          const q = row ? ctx.sb.from(cfg.table).update(rec).eq('id', row.id) : ctx.sb.from(cfg.table).insert(rec);
          const { error } = await q;
          if (failed(error)) return false;
          toast(row ? 'Changes saved.' : 'Added.');
          close(); await load(); cfg.onChange?.();
          return true;
        },
      }],
    });
  }

  async function remove(row) {
    const name = row.name || row.label || row.code || 'this item';
    const ok = await confirmDialog('Delete item', `Delete “${name}”? If it is already in use, switch it off instead.`, 'Delete', true);
    if (!ok) return;
    const { error } = await ctx.sb.from(cfg.table).delete().eq('id', row.id);
    if (failed(error, 'Delete')) return;
    toast('Deleted.'); await load(); cfg.onChange?.();
  }

  await load();
  return { reload: load };
}

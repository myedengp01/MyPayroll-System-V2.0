// Companies: details, employer numbers, logos
import { h, clear, pageHead, openModal, field, toast, failed, logoTile, confirmDialog } from '../ui.js';

const MAX_SIDE = 512;          // px, longest side after resize
const MAX_BYTES = 400 * 1024;  // keep rows small

/** Read an image file and return a resized data URL (PNG keeps transparency; WebP if PNG is too big). */
export function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(file.type)) return reject(new Error('Choose a PNG, JPG, WebP, SVG or GIF image.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a readable image.'));
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || MAX_SIDE, img.naturalHeight || MAX_SIDE));
        const w = Math.max(1, Math.round((img.naturalWidth || MAX_SIDE) * scale));
        const hgt = Math.max(1, Math.round((img.naturalHeight || MAX_SIDE) * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = hgt;
        c.getContext('2d').drawImage(img, 0, 0, w, hgt);
        let url = c.toDataURL('image/png');
        if (url.length * 0.75 > MAX_BYTES) url = c.toDataURL('image/webp', 0.9);
        if (url.length * 0.75 > MAX_BYTES) return reject(new Error('Image is still too large after resizing. Try a simpler file.'));
        resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export async function render(el, ctx) {
  const canWrite = ctx.can(['admin', 'hr']);
  const list = h('div', { class: 'company-list' });
  el.append(
    pageHead('Companies', 'Group companies used on payslips, reports and statutory files. The four marked “Login screen” appear on the sign-in page and sidebar.',
      canWrite ? h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Add company') : null),
    list);

  let rows = [];
  async function load() {
    const { data, error } = await ctx.sb.from('eppd_companies').select('*').order('sort_order').order('id');
    if (failed(error, 'Load')) return;
    rows = data || []; draw();
  }

  function draw() {
    clear(list);
    for (const c of rows) {
      const missing = ['epf_employer_no', 'socso_employer_no', 'tax_employer_no'].filter((k) => !c[k]).length;
      list.append(h('article', { class: `panel company-card ${c.is_active ? '' : 'inactive'}` },
        logoTile(c),
        h('div', {},
          h('h3', {}, c.name),
          h('div', { class: 'meta' }, c.code, c.registration_no ? ` · ${c.registration_no}` : ''),
          h('div', { class: 'row' },
            c.is_primary ? h('span', { class: 'tag ok' }, 'Login screen') : null,
            !c.is_active ? h('span', { class: 'tag' }, 'Inactive') : null,
            !c.logo ? h('span', { class: 'tag warn' }, 'No logo') : null,
            missing ? h('span', { class: 'tag warn' }, `${missing} employer no. missing`) : null),
          canWrite ? h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => edit(c) }, 'Edit')) : null)));
    }
  }

  function edit(c) {
    let logo = c?.logo || null;
    const preview = h('div', {});
    const drawPreview = () => clear(preview).append(logoTile({ ...(c || {}), name: c?.name || 'New company', logo }));
    drawPreview();
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif', class: 'hidden' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      try { logo = await resizeImage(f); drawPreview(); } catch (e) { toast(e.message, 'error'); }
      fileIn.value = '';
    });
    const F = {
      code: field('Short code', { value: c?.code, required: true, hint: 'e.g. MEG. Used in reports and IDs.' }),
      name: field('Registered name', { value: c?.name, required: true }),
      short_name: field('Display name', { value: c?.short_name }),
      registration_no: field('Registration no. (SSM)', { value: c?.registration_no }),
      epf_employer_no: field('EPF employer no.', { value: c?.epf_employer_no }),
      socso_employer_no: field('SOCSO employer no.', { value: c?.socso_employer_no }),
      tax_employer_no: field('LHDN employer no. (E-number)', { value: c?.tax_employer_no }),
      phone: field('Phone', { value: c?.phone }),
      email: field('Email', { type: 'email', value: c?.email }),
      sort_order: field('Display order', { type: 'number', value: c?.sort_order ?? rows.length + 1 }),
      address: field('Address (shown on payslips)', { type: 'textarea', value: c?.address, span2: true }),
      is_primary: field('Show on login screen and sidebar', { type: 'switch', value: c?.is_primary, span2: true }),
      is_active: field('Active', { type: 'switch', value: c ? c.is_active : true, span2: true }),
    };
    const body = h('div', {},
      h('div', { class: 'logo-editor', style: 'margin-bottom:1.2rem' }, preview,
        h('div', { style: 'display:grid;gap:.5rem' },
          h('div', { class: 'side-actions' },
            h('button', { class: 'btn sm', type: 'button', onclick: () => fileIn.click() }, logo ? 'Replace logo' : 'Upload logo'),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { logo = null; drawPreview(); } }, 'Remove')),
          h('p', { class: 'small muted' }, 'PNG with a transparent background works best. Resized to 512 px automatically.'),
          fileIn)),
      h('div', { class: 'form-grid' }, Object.values(F)));
    openModal({
      title: c ? `Edit ${c.short_name || c.name}` : 'Add company', body, wide: true,
      actions: [{
        label: c ? 'Save changes' : 'Add company', primary: true,
        onClick: async (close) => {
          const rec = { logo };
          for (const [k, f] of Object.entries(F)) rec[k] = f.getValue();
          if (!rec.code || !rec.name) { toast('Short code and registered name are required.', 'error'); return false; }
          rec.code = rec.code.toUpperCase();
          if (rec.is_primary && !c?.is_primary && rows.filter((r) => r.is_primary).length >= 4) {
            const ok = await confirmDialog('More than four on the login screen',
              'The login screen is designed for four logos. Show this company there anyway?', 'Show it');
            if (!ok) return false;
          }
          const q = c ? ctx.sb.from('eppd_companies').update(rec).eq('id', c.id) : ctx.sb.from('eppd_companies').insert(rec);
          const { error } = await q;
          if (failed(error)) return false;
          toast(c ? 'Company saved.' : 'Company added.');
          close(); await load(); await ctx.refreshBrand();
          return true;
        },
      }],
    });
  }

  await load();
}

// MyPayroll-System-V2.0 · app.js — auth flow, app shell, hash router
import { sb, isConfigured } from './supabase.js';
import { VERSION, APP_NAME } from './version.js';
import { h, clear, toast, logoTile } from './ui.js';

const root = document.getElementById('app');
const state = { session: null, me: null, brand: [], recovery: false, modules: {} };

// ---------------------------------------------------------------- routes
const ROUTES = {
  'dashboard':              { label: 'Overview',               load: () => import('./modules/dashboard.js') },
  'employees':              { label: 'Employees',              load: () => import('./modules/employees.js') },
  'employees/:id':          { label: 'Employee',               load: () => import('./modules/employee.js'), menu: 'employees' },
  'employees/former':       { label: 'Former staff',           load: () => import('./modules/formerstaff.js') },
  'employees/ids':          { label: 'Employee IDs',           load: () => import('./modules/eid.js') },
  'employees/import':       { label: 'Import from workbook',   load: () => import('./modules/import.js'), roles: ['admin'] },
  'leave':                  { label: 'Leave records',          load: () => import('./modules/leave.js'), roles: ['admin', 'hr'] },
  'leave/balances':         { label: 'Leave balances',         load: () => import('./modules/balances.js'), roles: ['admin', 'hr'] },
  'leave/al-calculator':    { label: 'AL calculator',          load: () => import('./modules/alcalc.js'), roles: ['admin', 'hr'] },
  'leave/year-end':         { label: 'Year-end close',         load: () => import('./modules/yearclose.js'), roles: ['admin', 'hr'] },
  'time':                   { label: 'Overtime & hours',       load: () => import('./modules/overtime.js'), roles: ['admin', 'hr'] },
  'leave/import':           { label: 'Import leave',           load: () => import('./modules/leaveimportpage.js'), roles: ['admin'] },
  'payroll':                { label: 'Monthly payroll',        load: () => import('./modules/payroll.js'), roles: ['admin', 'hr'] },
  'payroll/:period':        { label: 'Monthly payroll',        load: () => import('./modules/payroll.js'), roles: ['admin', 'hr'], menu: 'payroll' },
  'reports':                { label: 'Payslips & reports',     load: () => import('./modules/reports.js'), roles: ['admin', 'hr'] },
  'claims':                 { label: 'MEG-FORMS claims',       load: () => import('./modules/claims.js'), roles: ['admin', 'hr'], module: 'claims' },
  'loans':                  { label: 'Company loans',          load: () => import('./modules/loans.js'), roles: ['admin', 'hr'], module: 'loans' },
  'settlements':            { label: 'Final settlement',       load: () => import('./modules/settlements.js'), roles: ['admin', 'hr'], module: 'settlement' },
  'payroll/import':         { label: 'Import past months',     load: () => import('./modules/payimportpage.js'), roles: ['admin'] },
  'settings/companies':     { label: 'Companies',              load: () => import('./modules/companies.js') },
  'settings/org':           { label: 'Departments & job titles', load: () => import('./modules/org.js') },
  'settings/lists':         { label: 'Pick-lists',             load: () => import('./modules/lists.js') },
  'settings/payment-types': { label: 'Payment types',          load: () => import('./modules/paymenttypes.js') },
  'settings/statutory':     { label: 'Statutory tables',       load: () => import('./modules/statutory.js') },
  'settings/holidays':      { label: 'Public holidays',        load: () => import('./modules/holidays.js') },
  'settings/policies':      { label: 'HR policies',            load: () => import('./modules/policies.js') },
  'settings/users':         { label: 'Users & access',         load: () => import('./modules/users.js'), roles: ['admin'] },
  'settings/audit':         { label: 'Audit log',              load: () => import('./modules/audit.js'), roles: ['admin'] },
};
const MENU = [
  { group: null, items: ['dashboard'] },
  { group: 'People', items: ['employees', 'employees/former', 'employees/ids', 'employees/import'] },
  { group: 'Time & leave', items: ['leave', 'leave/balances', 'leave/al-calculator', 'leave/year-end', 'time', 'leave/import'] },
  { group: 'Payroll', items: ['payroll', 'reports', 'claims', 'loans', 'settlements', 'payroll/import'] },
  { group: 'Settings', items: ['settings/companies', 'settings/org', 'settings/lists', 'settings/payment-types',
    'settings/statutory', 'settings/holidays', 'settings/policies', 'settings/users', 'settings/audit'] },
];

/** '#/employees/42?tab=pay' -> { key:'employees/:id', params:{id:'42'}, query:{tab:'pay'} } */
function matchRoute(hash) {
  const [path, qs] = hash.replace(/^#\/?/, '').split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const clean = path || 'dashboard';
  if (ROUTES[clean]) return { key: clean, params: {}, query };
  const parts = clean.split('/');
  for (const key of Object.keys(ROUTES)) {
    const kp = key.split('/');
    if (kp.length !== parts.length) continue;
    const params = {};
    if (kp.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) return { key, params, query };
  }
  return { key: 'dashboard', params: {}, query };
}

const can = (roles) => !!state.me && state.me.status === 'active' && roles.includes(state.me.role);
const ctx = {
  sb, can, VERSION,
  get modules() { return state.modules; },
  async reloadModules() { await loadModules(); renderShell(); },
  get me() { return state.me; },
  get session() { return state.session; },
  get brand() { return state.brand; },
  refreshBrand: async () => { await loadBrand(); renderSidebarBrand(); },
};

// ---------------------------------------------------------------- boot
async function loadBrand() {
  if (!isConfigured) return;
  const { data } = await sb.rpc('eppd_brand');
  state.brand = data || [];
}

async function boot() {
  await loadBrand();
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  // Supabase advises not awaiting other supabase calls inside this callback
  // (it can deadlock), so follow-up work is deferred with setTimeout.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      state.recovery = true; state.session = session; setTimeout(() => renderAuth('reset'), 0); return;
    }
    const changed = (session?.user?.id || null) !== (state.session?.user?.id || null);
    state.session = session;
    if (changed) setTimeout(route, 0);
  });
  window.addEventListener('hashchange', () => { if (state.me?.status === 'active') renderPage(); });
  await route();
}

async function route() {
  if (state.recovery) return;
  if (!state.session) { state.me = null; renderAuth('login'); return; }
  state.me = await loadOrRegisterMe();
  if (!state.me) { renderAuth('login', 'Could not load your access record. Please try again.'); return; }
  if (state.me.status !== 'active') { renderPending(); return; }
  await loadModules();
  renderShell();
}

/** Optional modules (Phase 6), switched on in Settings › HR policies. */
async function loadModules() {
  try { const { data } = await sb.from('eppd_policies').select('value').eq('key', 'modules').maybeSingle(); state.modules = data?.value || {}; }
  catch { state.modules = {}; }
}
const moduleOn = (m) => (!m ? true : m === 'claims' ? !!state.modules.claims?.enabled : !!state.modules[m]);

async function loadOrRegisterMe() {
  const u = state.session.user;
  let { data, error } = await sb.from('eppd_user_roles').select('*').eq('user_id', u.id).maybeSingle();
  if (error) { console.error(error); return null; }
  if (!data) {
    // first sign-in to this app: register as pending viewer (RLS allows only this)
    const ins = await sb.from('eppd_user_roles')
      .insert({ user_id: u.id, email: u.email, display_name: u.user_metadata?.display_name || null })
      .select().single();
    if (ins.error) { console.error(ins.error); return null; }
    data = ins.data;
  }
  return data;
}

// ---------------------------------------------------------------- auth screens
function brandPanel() {
  const tiles = [];
  for (let i = 0; i < 4; i++) tiles.push(logoTile(state.brand[i] || { short_name: 'Logo' }));
  return h('section', { class: 'login-brand' },
    h('div', {},
      h('h1', {}, 'Payroll for the MyEden family'),
      h('p', { class: 'lede' }, 'Staff records, leave, monthly payroll and payslips for every company in the group, in one place.')),
    h('div', { class: 'logo-cluster', 'aria-label': 'Group companies' }, tiles),
    h('p', { class: 'uvn' }, `${APP_NAME} · ${VERSION}`));
}

function pwInput(id, autocomplete) {
  const input = h('input', { id, type: 'password', required: true, autocomplete, minlength: 6 });
  const btn = h('button', { class: 'btn ghost sm pw-toggle', type: 'button', 'aria-label': 'Show password' }, '👁');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  return h('div', { class: 'pw-wrap' }, input, btn);
}

function renderAuth(mode = 'login', message = '') {
  clear(root);
  const msg = h('p', { class: `form-msg ${message ? 'error' : ''}`, role: 'status' }, message);
  const setMsg = (t, kind = 'error') => { msg.textContent = t; msg.className = `form-msg ${kind}`; };
  const email = h('input', { id: 'email', type: 'email', required: true, autocomplete: 'email' });
  let form;

  if (mode === 'login') {
    const pw = pwInput('pw', 'current-password');
    form = h('form', {},
      h('div', {}, h('h2', {}, 'Sign in'), h('p', { class: 'muted small' }, 'Use your MyEden staff account.')),
      h('label', { class: 'field', for: 'email' }, 'Email', email),
      h('label', { class: 'field', for: 'pw' }, 'Password', pw),
      msg,
      h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
      h('p', { class: 'small' },
        h('button', { class: 'linkish', type: 'button', onclick: () => renderAuth('forgot') }, 'Forgot password?'),
        ' · ',
        h('button', { class: 'linkish', type: 'button', onclick: () => renderAuth('signup') }, 'Create an account')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); setMsg('');
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.querySelector('input').value });
      if (error) setMsg(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message);
    });
  } else if (mode === 'signup') {
    const name = h('input', { id: 'name', type: 'text', required: true, autocomplete: 'name' });
    const pw = pwInput('pw', 'new-password');
    form = h('form', {},
      h('div', {}, h('h2', {}, 'Create an account'),
        h('p', { class: 'muted small' }, 'An admin approves new accounts before you can see any data.')),
      h('label', { class: 'field', for: 'name' }, 'Your name', name),
      h('label', { class: 'field', for: 'email' }, 'Email', email),
      h('label', { class: 'field', for: 'pw' }, 'Password (at least 6 characters)', pw),
      msg,
      h('button', { class: 'btn primary', type: 'submit' }, 'Create account'),
      h('p', { class: 'small' }, h('button', { class: 'linkish', type: 'button', onclick: () => renderAuth('login') }, 'Back to sign in')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); setMsg('');
      const { data, error } = await sb.auth.signUp({
        email: email.value.trim(), password: pw.querySelector('input').value,
        options: { data: { display_name: name.value.trim() }, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) return setMsg(error.message);
      if (!data.session) setMsg('Account created. Check your email to confirm it, then sign in.', 'info');
    });
  } else if (mode === 'forgot') {
    form = h('form', {},
      h('div', {}, h('h2', {}, 'Reset your password'), h('p', { class: 'muted small' }, 'We will email you a reset link.')),
      h('label', { class: 'field', for: 'email' }, 'Email', email),
      msg,
      h('button', { class: 'btn primary', type: 'submit' }, 'Send reset link'),
      h('p', { class: 'small' }, h('button', { class: 'linkish', type: 'button', onclick: () => renderAuth('login') }, 'Back to sign in')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + location.pathname });
      if (error) setMsg(error.message); else setMsg('Reset link sent. Check your inbox.', 'info');
    });
  } else if (mode === 'reset') {
    const pw = pwInput('pw', 'new-password');
    form = h('form', {},
      h('div', {}, h('h2', {}, 'Choose a new password')),
      h('label', { class: 'field', for: 'pw' }, 'New password', pw),
      msg,
      h('button', { class: 'btn primary', type: 'submit' }, 'Save new password'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: pw.querySelector('input').value });
      if (error) return setMsg(error.message);
      state.recovery = false; toast('Password updated.'); history.replaceState(null, '', location.pathname); route();
    });
  }

  const side = h('section', { class: 'login-form' },
    !isConfigured ? h('p', { class: 'setup-warning' },
      'Setup needed: paste the Supabase anon key into js/config.js, then reload.') : null,
    form,
    h('p', { class: 'uvn', style: 'margin-top:2rem' }, VERSION));
  root.appendChild(h('div', { class: 'login' }, brandPanel(), side));
  (form.querySelector('input'))?.focus();
}

function renderPending() {
  clear(root);
  const disabled = state.me.status === 'disabled';
  root.appendChild(h('div', { class: 'login' }, brandPanel(),
    h('section', { class: 'login-form' },
      h('h2', {}, disabled ? 'Access turned off' : 'Waiting for approval'),
      h('p', { class: 'muted', style: 'margin:.6rem 0 1.4rem' }, disabled
        ? 'An admin has turned off your access to this app. Contact HR if you think this is a mistake.'
        : `You're signed in as ${state.me.email}. An admin needs to approve your account and assign a role before you can continue.`),
      h('div', { class: 'side-actions' },
        h('button', { class: 'btn', onclick: () => route() }, 'Check again'),
        h('button', { class: 'btn ghost', onclick: () => sb.auth.signOut() }, 'Sign out')),
      h('p', { class: 'uvn', style: 'margin-top:2rem' }, VERSION))));
}

// ---------------------------------------------------------------- shell
let mainEl, sideBrandEl, shellEl;

function renderSidebarBrand() {
  if (!sideBrandEl) return;
  clear(sideBrandEl);
  const tiles = [];
  for (let i = 0; i < 4; i++) tiles.push(logoTile(state.brand[i] || { short_name: '—' }));
  sideBrandEl.append(h('div', { class: 'side-logos' }, tiles),
    h('strong', {}, 'MyPayroll V2.0'), h('span', { class: 'small muted' }, 'MyEden Group'));
}

function renderShell() {
  clear(root);
  sideBrandEl = h('div', { class: 'side-brand' });
  const nav = h('nav', { class: 'menu', 'aria-label': 'Main' });
  for (const g of MENU) {
    if (g.group) nav.append(h('div', { class: 'menu-group' }, g.group));
    for (const key of g.items || []) {
      const r = ROUTES[key];
      if (r.roles && !can(r.roles)) continue;
      if (!moduleOn(r.module)) continue;
      nav.append(h('a', { href: `#/${key}`, dataset: { route: key } }, r.label));
    }
    for (const [label, phase] of g.soon || []) nav.append(h('div', { class: 'soon' }, label, h('span', { class: 'tag' }, phase)));
  }
  const themeBtn = h('button', { class: 'btn sm', type: 'button' }, 'Theme');
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('eppd-theme', next); } catch (e) { /* storage blocked */ }
  });
  const sidebar = h('aside', { class: 'sidebar' }, sideBrandEl, nav,
    h('div', { class: 'side-foot' },
      h('div', { class: 'side-user' }, h('b', {}, state.me.display_name || state.me.email),
        h('span', { class: 'muted' }, `${state.me.role} · ${state.me.email}`)),
      h('div', { class: 'side-actions' }, themeBtn,
        h('button', { class: 'btn sm', type: 'button', onclick: () => sb.auth.signOut() }, 'Sign out'))));
  mainEl = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Open menu', onclick: () => shellEl.classList.toggle('menu-open') }, '☰'),
    h('strong', {}, 'MyPayroll V2.0'));
  shellEl = h('div', { class: 'shell' }, sidebar, h('div', {}, topbar, mainEl));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) shellEl.classList.remove('menu-open'); });
  root.appendChild(shellEl);
  renderSidebarBrand();
  if (!location.hash) location.hash = '#/dashboard'; else renderPage();
}

let renderToken = 0;
async function renderPage() {
  const m = matchRoute(location.hash);
  const allowed = ROUTES[m.key] && (!ROUTES[m.key].roles || can(ROUTES[m.key].roles)) && moduleOn(ROUTES[m.key].module);
  const key = allowed ? m.key : 'dashboard';
  const r = ROUTES[key];
  const menuKey = r.menu || key;
  document.querySelectorAll('.menu a').forEach((a) => a.classList.toggle('active', a.dataset.route === menuKey));
  document.title = `${r.label} · MyPayroll V2.0`;
  const token = ++renderToken;
  clear(mainEl).append(h('div', { class: 'loading' }, 'Loading…'));
  try {
    const mod = await r.load();
    if (token !== renderToken) return;
    const container = h('div', {});
    await mod.render(container, ctx, allowed ? m.params : {}, allowed ? m.query : {});
    if (token !== renderToken) return;
    clear(mainEl).append(container, h('p', { class: 'footer-uvn' }, `${APP_NAME} · ${VERSION}`));
    if (!m.query.keepScroll) window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    clear(mainEl).append(h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
      h('h2', {}, 'This page could not load'), h('p', { class: 'muted' }, String(err.message || err)))));
  }
}

boot();

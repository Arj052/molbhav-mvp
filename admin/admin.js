// Admin panel logic. All requests are relative to the secret admin path, and every
// one is checked on the server, so this file reveals nothing useful on its own.
(function () {
  const $ = (s) => document.querySelector(s);
  let users = [];
  let pendingRemove = null;
  let searchTimer = null;

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('api/' + path, {
      method,
      credentials: 'same-origin',
      headers: Object.assign({ 'X-MB-Request': '1' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('signed-out'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const cell = (text) => { const td = document.createElement('td'); td.textContent = text == null || text === '' ? '—' : String(text); return td; };

  function showLogin() { stopLive(); $('#appView').hidden = true; $('#loginView').hidden = false; }
  function showApp() { $('#loginView').hidden = true; $('#appView').hidden = false; loadAll(); startLive(); }

  // ---------- live updates: check for new numbers every few seconds, no page refresh ----------
  // (Polling, not streaming: free trycloudflare.com tunnels hold back streamed data.)
  const POLL_MS = 3000;
  let pollTimer = null; let lastSeenId = null; let lastTotal = null; let polling = false;
  function setLive(state, text) { $('#liveBadge').dataset.state = state; $('#liveText').textContent = text; }
  function toast(name, verb) {
    const t = document.createElement('div'); t.className = 'toast';
    const b = document.createElement('b'); b.textContent = name;
    t.append(b, document.createTextNode(' ' + verb));
    $('#toasts').prepend(t);
    while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove();
    setTimeout(() => t.remove(), 6000);
  }
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const s = await api('stats');
      setLive('on', 'Live');
      renderStats(s);
      const recent = s.recentLogins || [];
      const newest = recent.length ? recent[0].id : 0;
      let changed = lastTotal !== null && s.totalUsers !== lastTotal;
      if (lastSeenId !== null && newest > lastSeenId) {
        // oldest first, so toasts appear in the order people logged in
        recent.filter((e) => e.id > lastSeenId).reverse().forEach((e) => toast(e.name, 'just logged in'));
        changed = true;
      }
      if (lastSeenId === null || newest > lastSeenId) lastSeenId = newest;
      lastTotal = s.totalUsers;
      if (changed) { loadUsers().catch(() => {}); loadAudit().catch(() => {}); }
    } catch (e) {
      if (e.message !== 'signed-out') setLive('error', 'Reconnecting…');
    } finally { polling = false; }
  }
  function startLive() {
    stopLive();
    lastSeenId = null; lastTotal = null;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }
  function stopLive() { clearInterval(pollTimer); pollTimer = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) poll(); });

  // Sets a number and briefly highlights it if it changed.
  function setNum(sel, val) {
    const el = $(sel); const next = String(val);
    if (el.textContent === next) return;
    const changed = el.textContent !== '–';
    el.textContent = next;
    if (changed) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  }

  async function loadStats() { renderStats(await api('stats')); }

  function renderStats(s) {
    setNum('#sTotal', s.totalUsers);
    setNum('#sWeek', s.newThisWeek);
    setNum('#sToday', s.loginsToday);
    setNum('#sActive', s.activeNow);
    setNum('#sLogins', s.totalLogins);
    const types = $('#types');
    types.replaceChildren(...s.byType.map((t) => {
      const p = document.createElement('span'); p.className = 'pill';
      p.textContent = t.type; const b = document.createElement('b'); b.textContent = t.count; p.appendChild(b); return p;
    }));
  }

  function renderRows() {
    const tbody = $('#rows');
    if (!users.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 9; td.className = 'empty'; td.textContent = 'No one yet. Share your sign-up link to get started.';
      tr.appendChild(td); tbody.replaceChildren(tr); return;
    }
    tbody.replaceChildren(...users.map((u) => {
      const tr = document.createElement('tr');
      tr.append(cell(u.name), cell(u.viaGoogle ? u.email + ' · Google' : u.email), cell(u.business), cell(u.businessType), cell(u.city), cell(fmt(u.joinedAt)), cell(fmt(u.lastLoginAt)), cell(u.loginCount));
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn link'; btn.textContent = 'Remove';
      btn.setAttribute('aria-label', 'Remove ' + u.name);
      btn.addEventListener('click', () => askRemove(u));
      td.appendChild(btn); tr.appendChild(td);
      return tr;
    }));
  }

  async function loadUsers() {
    const q = $('#search').value.trim();
    const data = await api('users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    users = data.users; renderRows();
  }

  async function loadAudit() {
    const { events } = await api('audit');
    const labels = { admin_login: 'Admin signed in', admin_login_failed: 'Failed admin sign-in', user_removed: 'Person removed', user_signup_google: 'New sign-up with Google' };
    $('#audit').replaceChildren(...events.slice(0, 15).map((e) => {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = labels[e.action] || e.action;
      li.append(b, document.createTextNode(' · ' + fmt(e.at)));
      return li;
    }));
  }

  function loadAll() { Promise.all([loadStats(), loadUsers(), loadAudit()]).catch(() => {}); }

  function askRemove(u) {
    pendingRemove = u;
    $('#cName').textContent = `${u.name} (${u.email})`;
    $('#confirm').hidden = false; $('#cCancel').focus();
  }
  $('#cCancel').addEventListener('click', () => { $('#confirm').hidden = true; pendingRemove = null; });
  $('#cOk').addEventListener('click', async () => {
    if (!pendingRemove) return;
    const btn = $('#cOk'); btn.disabled = true;
    try { await api('users/' + pendingRemove.id, { method: 'DELETE' }); $('#confirm').hidden = true; pendingRemove = null; loadAll(); }
    catch (e) { if (e.message !== 'signed-out') alertInline(e.message); }
    finally { btn.disabled = false; }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#confirm').hidden) $('#cCancel').click(); });
  function alertInline(msg) { $('#cName').textContent = msg; }

  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadUsers().catch(() => {}), 250); });
  $('#refreshBtn').addEventListener('click', loadAll);
  $('#exportBtn').addEventListener('click', () => {
    const head = ['Name', 'Email', 'Business', 'Type', 'City', 'Joined', 'Last login', 'Logins'];
    const esc = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const lines = [head.map(esc).join(',')].concat(users.map((u) => [u.name, u.email, u.business, u.businessType, u.city, u.joinedAt, u.lastLoginAt, u.loginCount].map(esc).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'molbhav-people.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#logoutBtn').addEventListener('click', async () => { try { await api('logout', { method: 'POST', body: {} }); } catch (_) {} showLogin(); });

  $('#adminLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget; const btn = form.querySelector('button'); const err = $('#loginError');
    err.textContent = ''; btn.disabled = true;
    try {
      await api('login', { method: 'POST', body: Object.fromEntries(new FormData(form).entries()) });
      form.reset(); showApp();
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });

  // start
  api('config').then((c) => { $('#codeField').hidden = !c.twoFactor; }).catch(() => {});
  api('session').then(showApp).catch(() => showLogin());
})();

// Maintenance panel (admin only): edit the access-control matrix and read
// the flight recorder. The UI is only a convenience - the server re-checks
// admin clearance on every call, so hiding this panel is not the protection.

// Demo screens get shared, so e-mail addresses stay masked until someone clicks
// them. Cosmetic only: the admin API still returns them in full.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function maskEmail(email) {
  const [local, domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  // Fixed-length dots: the mask must not reveal how long the address is.
  return `${local.slice(0, 1)}••••••@${domain.slice(0, 1)}••••${tld}`;
}
const maskEmails = (text) => String(text).replace(EMAIL, maskEmail);

export function createMaintenance({ api, getMe, getStations, onCommitted, say, caution }) {
  const $ = (sel) => document.querySelector(sel);
  const panel = $('#maintenance');
  const button = $('#btn-maint');
  const guarded = $('#guarded');
  const commitBtn = $('#btn-commit');
  const msg = $('#commit-msg');
  let original = [];
  let draft = [];
  let recorderTimer = null;
  const revealed = new Set(); // flight-recorder entries whose e-mail an admin clicked open

  const clone = (users) => users.map((u) => ({ ...u, stations: [...u.stations] }));
  const stationsOf = (u) => (u.stations.includes('*') ? getStations().map((s) => s.id) : u.stations);
  const same = (a, b) => a.role === b.role && a.genesysEmail === b.genesysEmail
    && [...stationsOf(a)].sort().join() === [...stationsOf(b)].sort().join();

  function setMsg(text, kind = '') {
    msg.textContent = text;
    msg.className = `msg ${kind}`;
  }

  function disarm() {
    guarded.classList.remove('armed');
    commitBtn.disabled = true;
  }

  function renderMatrix() {
    const stations = getStations();
    const me = getMe();
    $('#matrix-head').innerHTML = `<th>Operator</th><th>Admin</th>${stations
      .map((s) => `<th>${s.name}<br><span style="opacity:.6">${s.icao}</span></th>`).join('')}<th>Genesys Cloud e-mail</th>`;
    const body = $('#matrix-body');
    body.innerHTML = '';
    draft.forEach((user, i) => {
      const tr = document.createElement('tr');
      tr.classList.toggle('dirty', !same(user, original[i]));
      const isAdmin = user.role === 'admin';
      const isSelf = user.username === me.username;
      const toggle = (name, checked, disabled, label, cls = '') => `
        <label class="toggle ${cls}" title="${label}">
          <input type="checkbox" data-k="${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${label}">
          <span class="lever"></span><span class="t-label">${checked ? 'ON' : 'OFF'}</span>
        </label>`;
      tr.innerHTML = `
        <td><span class="u-name"></span></td>
        <td>${toggle('role', isAdmin, isSelf, isSelf ? 'You cannot remove your own admin clearance' : `Admin clearance for ${user.username}`, 'role')}</td>
        ${stations.map((s) => `<td>${toggle(`st:${s.id}`, isAdmin || stationsOf(user).includes(s.id), isAdmin, `${s.name} for ${user.username}`)}</td>`).join('')}
        <td>
          <button type="button" class="email-mask" title="Click to show and edit" aria-label="Show Genesys Cloud e-mail for ${user.username}"></button>
          <input class="email-input hidden" type="email" data-k="email" placeholder="not linked" spellcheck="false" autocomplete="off" aria-label="Genesys Cloud e-mail for ${user.username}">
        </td>`;
      tr.querySelector('.u-name').textContent = user.username;
      const email = tr.querySelector('[data-k="email"]');
      const mask = tr.querySelector('.email-mask');
      email.value = user.genesysEmail;
      // Masked by default; a click opens the real field, leaving it masks it again.
      const showMasked = () => {
        const value = email.value.trim().toLowerCase();
        mask.textContent = value ? maskEmail(value) : 'not linked';
        mask.classList.toggle('empty', !value);
        mask.classList.remove('hidden');
        email.classList.add('hidden');
      };
      mask.addEventListener('click', () => {
        mask.classList.add('hidden');
        email.classList.remove('hidden');
        email.focus();
      });
      email.addEventListener('blur', showMasked);
      email.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === 'Escape') email.blur(); });
      showMasked();
      tr.addEventListener('change', (ev) => onEdit(i, ev.target));
      tr.addEventListener('input', (ev) => { if (ev.target.dataset.k === 'email') onEdit(i, ev.target, false); });
      body.append(tr);
    });
  }

  function onEdit(i, input, rerender = true) {
    const user = draft[i];
    const key = input.dataset.k;
    if (key === 'role') {
      user.role = input.checked ? 'admin' : 'agent';
      if (user.role === 'agent' && user.stations.includes('*')) user.stations = getStations().map((s) => s.id);
    } else if (key?.startsWith('st:')) {
      const id = key.slice(3);
      const list = new Set(stationsOf(user));
      if (input.checked) list.add(id); else list.delete(id);
      user.stations = getStations().map((s) => s.id).filter((s) => list.has(s));
    } else if (key === 'email') {
      user.genesysEmail = input.value.trim().toLowerCase();
    }
    const dirty = draft.filter((u, j) => !same(u, original[j])).length;
    setMsg(dirty ? `${dirty} operator(s) modified - lift the guard and commit.` : 'No pending changes.');
    if (rerender) renderMatrix();
    else input.closest('tr').classList.toggle('dirty', !same(user, original[i]));
  }

  async function load() {
    const { users } = await api('/api/admin/users');
    original = clone(users);
    draft = clone(users);
    renderMatrix();
    disarm();
  }

  async function commit() {
    const changes = draft.filter((u, i) => !same(u, original[i]));
    disarm();
    if (!changes.length) return setMsg('No pending changes.');
    const errors = [];
    for (const user of changes) {
      const stations = user.role === 'admin' ? ['*'] : stationsOf(user);
      try {
        await api(`/api/admin/users/${encodeURIComponent(user.username)}`, {
          method: 'PUT',
          body: { role: user.role, stations, genesysEmail: user.genesysEmail },
        });
      } catch (err) {
        errors.push(`${user.username}: ${err.message}`);
      }
    }
    await load();
    await refreshRecorder();
    if (errors.length) {
      setMsg(`COMMIT PARTIALLY FAILED - ${errors.join(' | ')}`, 'error');
      caution('PERMISSION COMMIT FAILED');
    } else {
      setMsg(`COMMITTED ${changes.length} change(s) to data/users.txt`, 'ok');
      say(`PERMISSION TABLE COMMITTED (${changes.map((u) => u.username).join(', ')})`);
    }
    await onCommitted();
  }

  async function refreshRecorder() {
    const box = $('#recorder');
    try {
      const { entries } = await api('/api/admin/audit');
      if (!entries.length) {
        box.innerHTML = '<div class="empty">NO EVENTS RECORDED_</div>';
        return;
      }
      box.innerHTML = '';
      for (const e of entries) {
        const line = document.createElement('div');
        line.className = `line${e.result === 'DENIED' ? ' denied' : ''}${e.action === 'CHANGE PERMISSIONS' ? ' change' : ''}`;
        const cells = [
          new Date(e.at).toLocaleTimeString('en-GB', { hour12: false }),
          e.actor, e.source, e.action, e.target || e.detail, e.result,
        ];
        const key = `${e.at}|${e.action}|${e.actor}`;
        const open = revealed.has(key);
        cells.forEach((text, idx) => {
          const span = document.createElement('span');
          if (idx === 2) span.className = 'src';
          let shown = String(text);
          if (idx === 4) {
            const hasEmail = maskEmails(shown) !== shown || maskEmails(e.detail || '') !== (e.detail || '');
            if (hasEmail) {
              span.classList.add('masked');
              span.addEventListener('click', () => {
                if (open) revealed.delete(key); else revealed.add(key);
                refreshRecorder();
              });
              if (!open) shown = maskEmails(shown);
            }
            if (e.detail) span.title = open ? e.detail : `${maskEmails(e.detail)}${hasEmail ? ' (click to show)' : ''}`;
          }
          span.textContent = shown.toUpperCase();
          line.append(span);
        });
        box.append(line);
      }
    } catch (err) {
      box.textContent = `RECORDER UNAVAILABLE: ${err.message}`;
    }
  }

  async function open() {
    try {
      await load();
    } catch (err) {
      caution(err.message);
      return;
    }
    panel.classList.remove('hidden');
    button.setAttribute('aria-pressed', 'true');
    setMsg('Flip the switches, lift the guard, commit. Changes are written to data/users.txt and apply instantly.');
    await refreshRecorder();
    clearInterval(recorderTimer);
    recorderTimer = setInterval(refreshRecorder, 3000);
  }

  function close() {
    panel.classList.add('hidden');
    button.setAttribute('aria-pressed', 'false');
    clearInterval(recorderTimer);
    disarm();
  }

  button.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()));
  $('#btn-guard').addEventListener('click', () => {
    guarded.classList.add('armed');
    commitBtn.disabled = false;
    commitBtn.focus();
  });
  commitBtn.addEventListener('click', commit);
  $('#btn-discard').addEventListener('click', () => {
    draft = clone(original);
    renderMatrix();
    disarm();
    setMsg('Pending changes discarded.');
  });

  return { open, close };
}

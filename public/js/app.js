// WX-84 Weather Command Unit - main console logic.
import { api, getToken, setToken, clearToken, ApiError } from './api.js';
import { installDefs, createDial, createCompass } from './instruments.js';
import { newHandoffId, openSignInPopup, waitForHandoff } from './genesys-link.js';
import { createMaintenance } from './maintenance.js';

const $ = (sel) => document.querySelector(sel);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ME_POLL_MS = 4000;
const WEATHER_POLL_MS = 60000;

const state = {
  config: null,
  stations: [],
  me: null,
  modules: new Map(),
  weather: null,
  embedded: false,
  conversationId: null,
  requestedStation: null,
  customerName: null, // from the chat bot, shown only - never stored
  timers: [],
  cautionTimer: null,
};

// ---------------------------------------------------------------- display

function show(viewId) {
  for (const id of ['view-login', 'view-link', 'view-cockpit']) $(`#${id}`).classList.toggle('hidden', id !== viewId);
}

function lamp(id, color, sub, { blink = false } = {}) {
  const el = $(`#lamp-${id}`);
  el.classList.remove('green', 'amber', 'red', 'blink');
  if (color) el.classList.add(color);
  if (blink) el.classList.add('blink');
  if (sub !== undefined) el.querySelector('small').textContent = sub;
}

function say(text) {
  const time = new Date().toISOString().slice(11, 19);
  $('#status-line').textContent = `> ${time}Z ${text}`;
}

function caution(text) {
  lamp('caution', 'red', 'CAUTION', { blink: true });
  say(`CAUTION: ${text}`);
  clearTimeout(state.cautionTimer);
  state.cautionTimer = setTimeout(acknowledgeCaution, 15000);
}
function acknowledgeCaution() {
  clearTimeout(state.cautionTimer);
  lamp('caution', null, 'CAUTION');
}
$('#lamp-caution').addEventListener('click', acknowledgeCaution);

function startClock() {
  const tick = () => {
    $('#utc-clock').textContent = new Date().toISOString().slice(11, 19);
    for (const mod of state.modules.values()) {
      if (mod.utcOffsetSeconds === null) continue;
      const local = new Date(Date.now() + mod.utcOffsetSeconds * 1000).toISOString().slice(11, 16);
      mod.el.querySelector('[data-f="local"]').textContent = local;
    }
  };
  tick();
  setInterval(tick, 1000);
}

// ------------------------------------------------------------ sign-in flow

async function boot() {
  installDefs();
  startClock();
  const params = new URLSearchParams(location.search);
  state.embedded = params.get('mode') === 'genesys' || params.has('gcHostOrigin');
  const conversationId = params.get('conversationId') || params.get('gcConversationId') || '';
  state.conversationId = UUID.test(conversationId) ? conversationId : null;
  document.body.classList.toggle('embedded', state.embedded);

  try {
    state.config = await api('/api/config');
  } catch (err) {
    say(`BOOT FAILURE - ${err.message}`);
    lamp('data', 'red', 'NO SERVER');
    return;
  }
  state.stations = state.config.stations;
  say(state.embedded ? 'EMBEDDED MODE - GENESYS CLOUD HOST DETECTED' : 'STANDALONE MODE');

  if (getToken()) {
    try {
      await enterCockpit();
      return;
    } catch {
      clearToken();
    }
  }
  showSignIn();
}

async function showSignIn() {
  stopPolling();
  state.me = null;
  lamp('auth', null, 'NO OPERATOR');
  lamp('genesys', null, state.config.genesys.configured ? 'STANDBY' : 'NOT SET UP');

  if (state.embedded) {
    show('view-link');
    $('#link-crt').textContent = state.config.genesys.configured
      ? '> LINK REQUIRED. PRESS ENGAGE TO VERIFY OPERATOR IDENTITY_'
      : '> GENESYS LINK NOT CONFIGURED ON THIS UNIT. RUN: npm run genesys:setup';
    return;
  }

  show('view-login');
  const keys = $('#local-keys');
  keys.innerHTML = '';
  if (state.config.localLogin) {
    const { users } = await api('/api/login-users');
    for (const user of users) {
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'keycap';
      key.dataset.role = user.role;
      key.innerHTML = `<span class="k-led"></span><span class="k-name"></span><span class="k-role"></span>`;
      key.querySelector('.k-name').textContent = user.username;
      key.querySelector('.k-role').textContent = user.role === 'admin' ? 'Clearance: admin' : 'Clearance: agent';
      key.addEventListener('click', () => localSignIn(user.username));
      keys.append(key);
    }
  }
  $('#sso-divider').classList.toggle('hidden', !state.config.localLogin);
  $('#genesys-sso').classList.toggle('hidden', !state.config.genesys.configured);
  $('#login-note').classList.toggle('hidden', !state.config.localLogin);
  $('#login-crt').textContent = state.config.localLogin
    ? '> AWAITING OPERATOR KEY_'
    : state.config.genesys.configured
      ? '> REMOTE ACCESS: GENESYS CLOUD VERIFIED SIGN-IN ONLY_'
      : '> NO SIGN-IN METHOD AVAILABLE FROM THIS ADDRESS_';
}

async function localSignIn(username) {
  try {
    const { token } = await api('/api/session/local', { method: 'POST', body: { username } });
    setToken(token);
    await enterCockpit();
  } catch (err) {
    $('#login-crt').textContent = `> ${err.message}`;
    caution(err.message);
  }
}

async function genesysSignIn(crt) {
  if (!state.config.genesys.configured) {
    crt.textContent = '> GENESYS LINK NOT CONFIGURED. RUN: npm run genesys:setup';
    return;
  }
  const handoff = newHandoffId();
  const popup = openSignInPopup(handoff);
  if (!popup) {
    crt.textContent = '> POP-UP BLOCKED. ALLOW POP-UPS FOR THIS UNIT AND PRESS AGAIN';
    caution('POP-UP BLOCKED');
    return;
  }
  lamp('genesys', 'amber', 'LINKING', { blink: true });
  crt.textContent = '> SIGN-IN WINDOW OPEN. VERIFYING IDENTITY WITH GENESYS CLOUD...';
  try {
    const { token } = await waitForHandoff(handoff, {
      onTick: (s) => { crt.textContent = `> VERIFYING IDENTITY WITH GENESYS CLOUD... ${s}s`; },
    });
    setToken(token);
    await enterCockpit();
  } catch (err) {
    if (err.message === 'SUPERSEDED') return;
    crt.textContent = `> ${err.message}`;
    lamp('genesys', 'red', err.status === 403 ? 'DENIED' : 'FAILED');
    caution(err.message);
  }
}
$('#btn-engage').addEventListener('click', () => genesysSignIn($('#link-crt')));
$('#btn-genesys-login').addEventListener('click', () => genesysSignIn($('#login-crt')));

async function signOut(reason = 'OPERATOR DISENGAGED') {
  try { await api('/api/session', { method: 'DELETE' }); } catch { /* already gone */ }
  clearToken();
  maintenance.close();
  say(reason);
  showSignIn();
}
$('#btn-logout').addEventListener('click', () => signOut());

// ----------------------------------------------------------------- cockpit

async function enterCockpit() {
  state.me = await api('/api/me');
  show('view-cockpit');
  renderOperator();
  buildModules();
  await refreshWeather();
  startPolling();
  if (state.me.source === 'genesys' && state.conversationId) checkConversation();
  say(`OPERATOR ${state.me.username.toUpperCase()} ONLINE - ${state.me.stations.length} OF ${state.stations.length} STATIONS CLEARED`);
}

function renderOperator() {
  const me = state.me;
  $('#op-name').textContent = me.genesys ? `${me.username} / ${me.genesys.name}` : me.username;
  $('#op-role').textContent = me.role;
  $('#op-source').textContent = me.source === 'genesys' ? 'Genesys Cloud' : 'Local key';
  $('#op-stations').textContent = `${me.stations.length} / ${state.stations.length}`;
  lamp('auth', 'green', me.role === 'admin' ? 'ADMIN' : 'AGENT');
  lamp('genesys', me.source === 'genesys' ? 'green' : null, me.source === 'genesys' ? 'VERIFIED' : 'NOT USED');
  const isAdmin = me.role === 'admin';
  $('#btn-maint').classList.toggle('hidden', !isAdmin);
  if (!isAdmin) maintenance.close();
}

function moduleTemplate(station) {
  return `
    <header class="module-head">
      <span class="status-led" aria-hidden="true"></span>
      <div>
        <h2 class="engraved">${station.name}</h2>
        <span class="sub engraved dim">${station.region} · ${station.country}</span>
      </div>
      <span class="icao-plate">${station.icao}</span>
    </header>
    <div class="module-body">
      <div class="crt screen">
        <div class="row"><span>LCL <span data-f="local">--:--</span></span><span data-f="daynight">----</span></div>
        <div>
          <div class="temp" data-f="temp">--.-<small>°C</small></div>
          <div class="sub-temp" data-f="subtemp">---°F · FEELS --°C</div>
        </div>
        <div class="cond" data-f="cond">NO SIGNAL</div>
      </div>
      <div class="instruments" data-f="instruments"></div>
    </div>
    <dl class="readouts">
      <div><dt>GUST</dt><dd data-f="gust">--</dd></div>
      <div><dt>CLOUD</dt><dd data-f="cloud">--</dd></div>
      <div><dt>PRECIP</dt><dd data-f="precip">--</dd></div>
      <div><dt>HI / LO</dt><dd data-f="hilo">--</dd></div>
      <div><dt>SUNRISE</dt><dd data-f="sunrise">--</dd></div>
      <div><dt>SUNSET</dt><dd data-f="sunset">--</dd></div>
    </dl>
    <div class="lock-plate" aria-hidden="true">
      <div class="plate-inner">
        <div class="bulb"></div>
        <div class="denied">ACCESS DENIED</div>
        <div class="why" data-f="why"></div>
      </div>
    </div>`;
}

function buildModules() {
  const grid = $('#stations');
  grid.innerHTML = '';
  state.modules.clear();
  // Requested station first, then the ones this operator is cleared for, then locked ones.
  const rank = (s) => (s.id === state.requestedStation ? 0 : state.me.stations.includes(s.id) ? 1 : 2);
  const ordered = [...state.stations].sort((a, b) => rank(a) - rank(b));
  for (const station of ordered) {
    const el = document.createElement('article');
    el.className = 'module panel';
    el.dataset.station = station.id;
    el.innerHTML = moduleTemplate(station);
    const wind = createCompass({ label: 'Wind' });
    const baro = createDial({
      label: 'Baro hPa', unit: 'HPA', min: 960, max: 1050, major: 20, minor: 5,
      bands: [{ from: 960, to: 990, color: '#ff3b30' }],
    });
    const humidity = createDial({
      label: 'Humidity %', unit: 'RH %', min: 0, max: 100, major: 20, minor: 5,
      bands: [{ from: 85, to: 100, color: '#59d2ff' }],
    });
    el.querySelector('[data-f="instruments"]').append(wind.el, baro.el, humidity.el);
    grid.append(el);
    state.modules.set(station.id, { el, station, wind, baro, humidity, utcOffsetSeconds: null });
  }
  applyClearance();
}

function applyClearance() {
  const allowed = new Set(state.me.stations);
  for (const [id, mod] of state.modules) {
    const cleared = allowed.has(id);
    const previous = mod.el.dataset.state;
    if (cleared && previous === 'locked') mod.el.dataset.state = 'loading';
    if (!cleared) {
      mod.el.dataset.state = 'locked';
      mod.el.querySelector('[data-f="why"]').textContent =
        `Operator ${state.me.username} not cleared for ${mod.station.name}`;
      clearReadings(mod);
    } else if (!previous) {
      mod.el.dataset.state = 'loading';
    }
    mod.el.classList.toggle('focus', id === state.requestedStation);
  }
}

const set = (mod, field, text) => { mod.el.querySelector(`[data-f="${field}"]`).textContent = text; };
const hhmm = (iso) => (iso ? iso.slice(11, 16) : '--:--');
const num = (v, d = 0) => (typeof v === 'number' ? v.toFixed(d) : '--');

function clearReadings(mod) {
  mod.utcOffsetSeconds = null;
  set(mod, 'local', '--:--');
  set(mod, 'daynight', '----');
  mod.el.querySelector('[data-f="temp"]').innerHTML = '--.-<small>°C</small>';
  set(mod, 'subtemp', '░▒▓ NO SIGNAL ▓▒░');
  set(mod, 'cond', 'NO SIGNAL');
  for (const f of ['gust', 'cloud', 'precip', 'hilo', 'sunrise', 'sunset']) set(mod, f, '--');
  mod.wind.set(null, null);
  mod.baro.set(null);
  mod.humidity.set(null);
}

function renderReading(mod, w) {
  mod.el.dataset.state = 'online';
  mod.utcOffsetSeconds = w.utcOffsetSeconds;
  set(mod, 'daynight', w.simulated ? 'SIMULATED' : w.isDay ? 'DAY' : 'NIGHT');
  mod.el.querySelector('[data-f="temp"]').innerHTML = `${num(w.temperatureC, 1)}<small>°C</small>`;
  set(mod, 'subtemp', `${num(w.temperatureC * 9 / 5 + 32, 0)}°F · FEELS ${num(w.feelsLikeC, 0)}°C`);
  set(mod, 'cond', w.condition);
  set(mod, 'gust', `${num(w.gustKt)} KT`);
  set(mod, 'cloud', `${num(w.cloudCoverPct)}%`);
  set(mod, 'precip', `${num(w.precipitationMm, 1)} MM`);
  set(mod, 'hilo', w.highC === null ? '--' : `${num(w.highC)}/${num(w.lowC)}°`);
  set(mod, 'sunrise', hhmm(w.sunrise));
  set(mod, 'sunset', hhmm(w.sunset));
  mod.wind.set(w.windDirDeg, w.windKt);
  mod.baro.set(w.pressureHpa);
  mod.humidity.set(w.humidityPct);
}

async function refreshWeather() {
  try {
    const data = await api('/api/weather');
    state.weather = data;
    for (const [id, mod] of state.modules) {
      if (data.stations[id]) renderReading(mod, data.stations[id]);
    }
    const sim = data.source === 'simulation';
    lamp('data', sim ? 'amber' : 'green', sim ? 'SIMULATION' : 'OPEN-METEO');
    $('#status-meta').textContent = `Weather: ${sim ? 'simulated (offline)' : 'Open-Meteo.com'} · fetched ${data.fetchedAt.slice(11, 16)}Z`;
  } catch (err) {
    if (err.status === 401) return signOut('SESSION ENDED');
    lamp('data', 'red', 'LINK LOST');
    say(`DATA LINK FAILURE - ${err.message}`);
  }
}

// Called every few seconds: picks up permission changes made by the admin
// (or by editing data/users.txt) without reloading the page.
async function pollMe() {
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) return signOut('SESSION ENDED - SIGN IN AGAIN');
    return;
  }
  const before = new Set(state.me.stations);
  const after = new Set(me.stations);
  const changed = me.permissionsVersion !== state.me.permissionsVersion || me.role !== state.me.role;
  state.me = me;
  if (!changed) return;
  const revoked = [...before].filter((id) => !after.has(id));
  const granted = [...after].filter((id) => !before.has(id));
  renderOperator();
  applyClearance();
  if (revoked.length) caution(`CLEARANCE REVOKED: ${revoked.join(', ').toUpperCase()}`);
  else if (granted.length) say(`CLEARANCE GRANTED: ${granted.join(', ').toUpperCase()}`);
  else say('PERMISSION TABLE UPDATED');
  if (granted.length) await refreshWeather();
  if (state.requestedStation) verifyRequestedStation();
}

function startPolling() {
  stopPolling();
  state.timers.push(setInterval(pollMe, ME_POLL_MS), setInterval(refreshWeather, WEATHER_POLL_MS));
}
function stopPolling() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

// ------------------------------------------------------- conversation link

async function checkConversation() {
  const panel = $('#incoming');
  panel.classList.remove('hidden');
  $('#incoming-text').innerHTML = 'IDENTIFYING CUSTOMER REQUEST...';
  setVerdict(null, 'CHECKING');
  try {
    const { stationId, raw, customer } = await api(`/api/genesys/conversations/${state.conversationId}/station`);
    state.customerName = customer?.lastName || null;
    if (!stationId) {
      $('#incoming-text').innerHTML = `NO STATION SPECIFIED BY ${customerLabel()}<small>${raw ? `unknown value: ${escapeHtml(raw)}` : 'participant data "location" is empty'}</small>`;
      setVerdict('amber', 'NO DATA');
      return;
    }
    state.requestedStation = stationId;
    buildModules();
    if (state.weather) for (const [id, mod] of state.modules) if (state.weather.stations[id]) renderReading(mod, state.weather.stations[id]);
    await verifyRequestedStation();
  } catch (err) {
    $('#incoming-text').innerHTML = `CONVERSATION LOOKUP FAILED<small>${escapeHtml(err.message)}</small>`;
    setVerdict('red', 'ERROR');
  }
}

// Ask the server - not the UI - whether this operator may see the requested station.
async function verifyRequestedStation() {
  const station = state.stations.find((s) => s.id === state.requestedStation);
  const text = `${customerLabel()} REQUESTS ${station.name.toUpperCase()} (${station.icao})`;
  try {
    await api(`/api/weather/${station.id}`);
    $('#incoming-text').innerHTML = `${text}<small>clearance confirmed for operator ${escapeHtml(state.me.username)}</small>`;
    setVerdict('green', 'CLEARED');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403) throw err;
    $('#incoming-text').innerHTML = `${text}<small>operator ${escapeHtml(state.me.username)} has no clearance - transfer or escalate</small>`;
    setVerdict('red', 'DENIED');
    caution(`ACCESS DENIED FOR REQUESTED STATION ${station.name.toUpperCase()}`);
  }
}

// "CUSTOMER MUELLER" when the bot collected a name. The name is customer input:
// always escaped, because it ends up in innerHTML.
function customerLabel() {
  return state.customerName ? `CUSTOMER ${escapeHtml(state.customerName.toUpperCase())}` : 'CUSTOMER';
}

function setVerdict(color, text) {
  const el = $('#incoming-verdict');
  el.className = `lamp verdict${color ? ` ${color}` : ''}${color === 'red' ? ' blink' : ''}`;
  el.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------- maintenance

const maintenance = createMaintenance({
  api,
  getMe: () => state.me,
  getStations: () => state.stations,
  onCommitted: pollMe,
  say,
  caution,
});

boot();

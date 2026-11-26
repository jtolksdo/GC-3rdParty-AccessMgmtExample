// Customer page: pick a station, attach it to the chat as a custom attribute,
// open Genesys Cloud Messenger. Every chat goes to one queue; the station is
// context for the WX-84 console, which checks the agent's clearance for it.
const $ = (sel) => document.querySelector(sel);
const notice = (html, ok = false) => {
  const el = $('#notice');
  el.innerHTML = html;
  el.classList.toggle('ok', ok);
  el.classList.remove('hidden');
};

const ready = { database: false, messenger: false };
const waiters = [];
const whenReady = () => (ready.database && ready.messenger
  ? Promise.resolve()
  : new Promise((resolve) => waiters.push(resolve)));
const markReady = (key) => {
  ready[key] = true;
  if (ready.database && ready.messenger) waiters.splice(0).forEach((fn) => fn());
};

// Promise wrapper around Genesys("command", name, data, onSuccess, onError)
const command = (name, data = {}) => new Promise((resolve, reject) => {
  window.Genesys('command', name, data, resolve, reject);
});

function loadMessenger({ deploymentId, environment, scriptUrl }) {
  // Official Messenger snippet, parameterised from config/config.json
  (function (g, e, n, es, ys) {
    g._genesysJs = e;
    g[e] = g[e] || function () { (g[e].q = g[e].q || []).push(arguments); };
    g[e].t = 1 * new Date();
    g[e].c = es;
    ys = document.createElement('script');
    ys.async = 1;
    ys.src = n;
    ys.charset = 'utf-8';
    document.head.appendChild(ys);
  })(window, 'Genesys', scriptUrl, { environment, deploymentId });

  window.Genesys('subscribe', 'Database.ready', () => markReady('database'));
  window.Genesys('subscribe', 'Messenger.ready', () => markReady('messenger'));
}

async function startChat(station, button) {
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('selected', c.dataset.station === station.id));
  button.disabled = true;
  try {
    await whenReady();
    // Must be set BEFORE the first message, so it is attached to the conversation.
    await command('Database.set', { messaging: { customAttributes: { location: station.id } } });
    try {
      await command('Messenger.open');
    } catch { /* already open - fine */ }
    notice(`Briefing for <b>${station.name}</b> requested. Say hello in the chat window; the next available duty meteorologist answers.`, true);
  } catch (err) {
    notice(`Could not start the chat: ${String(err?.message || err)}`);
  } finally {
    button.disabled = false;
  }
}

const localTime = (timeZone) =>
  new Date().toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });

async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const stations = cfg.stations.filter((s) => s.customerSelectable);
  const blurbs = {
    'menlo-park': 'Bay Area marine layer, fog at the coast, Pacific fronts.',
    indianapolis: 'Midwest convection, lake-effect snow, severe-weather watches.',
    melbourne: 'Southern Ocean fronts and "four seasons in one day".',
  };

  const grid = $('#stations');
  for (const s of stations) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.station = s.id;
    card.innerHTML = `
      <div class="card-top"><span class="icao"></span><h2></h2><div class="where"></div></div>
      <div class="card-body">
        <div class="local-time"><span data-clock></span><small>local time</small></div>
        <p></p>
        <button class="chat-btn" type="button"></button>
      </div>`;
    card.querySelector('.icao').textContent = s.icao;
    card.querySelector('h2').textContent = s.name;
    card.querySelector('.where').textContent = `${s.region}, ${s.country}`;
    card.querySelector('p').textContent = blurbs[s.id] || '';
    const button = card.querySelector('.chat-btn');
    button.textContent = `Chat with ${s.name}`;
    button.disabled = !cfg.messenger.configured;
    button.addEventListener('click', () => startChat(s, button));
    const clock = card.querySelector('[data-clock]');
    const tick = () => { clock.textContent = localTime(s.timezone); };
    tick();
    setInterval(tick, 30000);
    grid.append(card);
  }

  if (!cfg.messenger.configured) {
    notice('Messenger is not configured yet. Run <code>npm run genesys:setup</code>, then reload this page.');
    return;
  }
  loadMessenger(cfg.messenger);
}

boot().catch((err) => notice(`Page failed to start: ${err.message}`));

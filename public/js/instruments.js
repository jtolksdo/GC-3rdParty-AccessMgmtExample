// SVG flight instruments: round dial gauges and a wind compass.
// Needles are rotated with CSS transitions, so they swing (and slightly
// overshoot) like real instruments whenever a new reading arrives.

const SWEEP = 240; // degrees of dial travel, centred on 12 o'clock
const LABEL = '#e8e3d4';

const polar = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [60 + r * Math.sin(a), 60 - r * Math.cos(a)];
};
const f = (n) => n.toFixed(2);

/** Shared gradients, injected once per document. */
export function installDefs() {
  if (document.getElementById('wx-defs')) return;
  document.body.insertAdjacentHTML('afterbegin', `
    <svg id="wx-defs" width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
        <radialGradient id="wx-bezel" cx="50%" cy="35%" r="70%">
          <stop offset="0" stop-color="#5a6167"/><stop offset=".55" stop-color="#2a2f33"/><stop offset="1" stop-color="#0f1112"/>
        </radialGradient>
        <radialGradient id="wx-face" cx="50%" cy="45%" r="60%">
          <stop offset="0" stop-color="#1b1e20"/><stop offset="1" stop-color="#070808"/>
        </radialGradient>
      </defs>
    </svg>`);
}

function frame(inner, label) {
  return `
    <svg viewBox="0 0 120 120" role="img" aria-label="${label}">
      <circle cx="60" cy="60" r="58" fill="url(#wx-bezel)" stroke="#000" stroke-width="1"/>
      <circle cx="60" cy="60" r="50" fill="url(#wx-face)" stroke="#000" stroke-width="1.5"/>
      ${inner}
      <ellipse cx="46" cy="36" rx="30" ry="17" fill="#fff" opacity=".045" transform="rotate(-24 46 36)"/>
    </svg>`;
}

function arc(r, fromDeg, toDeg, color, width) {
  const [x1, y1] = polar(r, fromDeg);
  const [x2, y2] = polar(r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `<path d="M${f(x1)} ${f(y1)} A${r} ${r} 0 ${large} 1 ${f(x2)} ${f(y2)}" fill="none" stroke="${color}" stroke-width="${width}" opacity=".85"/>`;
}

/**
 * Round dial, e.g. barometer or hygrometer.
 * spec: { label, unit, min, max, major, minor, decimals, bands: [{from, to, color}] }
 */
export function createDial(spec) {
  const { label, unit, min, max, major, minor, decimals = 0, bands = [] } = spec;
  const angle = (v) => -SWEEP / 2 + (SWEEP * (Math.min(max, Math.max(min, v)) - min)) / (max - min);
  let ticks = '';
  let numbers = '';
  for (let v = min; v <= max + 1e-9; v += minor) {
    const isMajor = Math.abs((v - min) / major - Math.round((v - min) / major)) < 1e-6;
    const [x1, y1] = polar(isMajor ? 39 : 43, angle(v));
    const [x2, y2] = polar(48, angle(v));
    ticks += `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
    if (isMajor) {
      const [tx, ty] = polar(31, angle(v));
      numbers += `<text x="${f(tx)}" y="${f(ty)}" fill="${LABEL}" font-size="7.5" font-family="B612, sans-serif" text-anchor="middle" dominant-baseline="central">${Math.round(v)}</text>`;
    }
  }
  const bandArcs = bands.map((b) => arc(45.5, angle(b.from), angle(b.to), b.color, 3)).join('');
  const inner = `
    ${bandArcs}
    <path d="${ticks}" stroke="${LABEL}" stroke-width="1.1" stroke-linecap="round"/>
    ${numbers}
    <text x="60" y="78" fill="#9c978a" font-size="6.5" font-family="B612, sans-serif" font-weight="700" text-anchor="middle" letter-spacing="1">${unit}</text>
    <rect x="41" y="85" width="38" height="13" rx="2" fill="#000" stroke="#2a2f33"/>
    <text class="dig" x="60" y="92" fill="#ffb000" font-size="11" font-family="VT323, monospace" text-anchor="middle" dominant-baseline="central">---</text>
    <g class="needle" style="transform: rotate(${-SWEEP / 2}deg)">
      <path d="M60 66 L57.8 60 L60 15 L62.2 60 Z" fill="#ffb000" stroke="#4a3000" stroke-width=".5"/>
    </g>
    <circle cx="60" cy="60" r="5.5" fill="#2b2f32" stroke="#000"/>
    <circle cx="60" cy="60" r="2" fill="#9aa0a6"/>`;

  const el = document.createElement('figure');
  el.className = 'gauge';
  el.innerHTML = `${frame(inner, label)}<figcaption>${label}</figcaption>`;
  const needle = el.querySelector('.needle');
  const dig = el.querySelector('.dig');
  return {
    el,
    set(value) {
      const ok = typeof value === 'number' && Number.isFinite(value);
      needle.style.transform = `rotate(${ok ? angle(value) : -SWEEP / 2}deg)`;
      dig.textContent = ok ? value.toFixed(decimals) : '---';
    },
  };
}

/** Wind compass: pointer shows the direction the wind comes FROM (aviation convention). */
export function createCompass({ label = 'Wind' } = {}) {
  let ticks = '';
  let marks = '';
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 10) {
    const isMajor = d % 30 === 0;
    const [x1, y1] = polar(isMajor ? 41 : 44, d);
    const [x2, y2] = polar(48, d);
    ticks += `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
    if (isMajor) {
      const [tx, ty] = polar(34, d);
      const text = names[d] || String(d / 10);
      const color = names[d] ? '#ffb000' : LABEL;
      marks += `<text x="${f(tx)}" y="${f(ty)}" fill="${color}" font-size="${names[d] ? 9 : 7}" font-weight="700" font-family="B612, sans-serif" text-anchor="middle" dominant-baseline="central" transform="rotate(${d} ${f(tx)} ${f(ty)})">${text}</text>`;
    }
  }
  const inner = `
    <path d="${ticks}" stroke="${LABEL}" stroke-width="1.1" stroke-linecap="round"/>
    ${marks}
    <g class="needle" style="transform: rotate(0deg)">
      <path d="M60 13 L65 27 L61.4 26 L61.4 52 L58.6 52 L58.6 26 L55 27 Z" fill="#3dff7a" stroke="#0a3a18" stroke-width=".6"/>
      <path d="M58.6 68 L61.4 68 L61.4 88 L64 95 L60 92 L56 95 L58.6 88 Z" fill="#3dff7a" opacity=".45"/>
    </g>
    <circle cx="60" cy="60" r="13" fill="#000" stroke="#2a2f33"/>
    <text class="spd" x="60" y="57.5" fill="#3dff7a" font-size="12" font-family="VT323, monospace" text-anchor="middle" dominant-baseline="central">--</text>
    <text x="60" y="66.5" fill="#9c978a" font-size="5" font-weight="700" font-family="B612, sans-serif" text-anchor="middle" letter-spacing=".6">KT</text>`;

  const el = document.createElement('figure');
  el.className = 'gauge';
  el.innerHTML = `${frame(inner, label)}<figcaption>${label}</figcaption>`;
  const needle = el.querySelector('.needle');
  const spd = el.querySelector('.spd');
  const caption = el.querySelector('figcaption');
  let current = 0;
  return {
    el,
    set(direction, speedKt) {
      const ok = typeof direction === 'number' && Number.isFinite(direction);
      const target = ok ? direction : 0;
      // take the short way round (350 deg -> 10 deg swings +20, not -340)
      const delta = ((((target - current) % 360) + 540) % 360) - 180;
      current += delta;
      needle.style.transform = `rotate(${current}deg)`;
      spd.textContent = typeof speedKt === 'number' ? Math.round(speedKt) : '--';
      caption.textContent = ok ? `${label} from ${String(Math.round(direction)).padStart(3, '0')}°` : label;
    },
  };
}

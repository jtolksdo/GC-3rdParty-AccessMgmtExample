// Weather readings from Open-Meteo (https://open-meteo.com, free, no API key).
// One request covers all stations; the result is cached for five minutes.
// If the internet is unavailable the unit switches to SIMULATION mode, so a
// live demo never shows an empty cockpit.
import { STATIONS } from './stations.js';

const CACHE_MS = 5 * 60 * 1000;
const CURRENT = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day', 'precipitation',
  'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];
const DAILY = ['temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset'];

// WMO weather interpretation codes, in cockpit wording
const CONDITIONS = {
  0: 'CLEAR SKIES', 1: 'MAINLY CLEAR', 2: 'PARTLY CLOUDY', 3: 'OVERCAST',
  45: 'FOG', 48: 'RIME FOG',
  51: 'LIGHT DRIZZLE', 53: 'DRIZZLE', 55: 'HEAVY DRIZZLE', 56: 'FREEZING DRIZZLE', 57: 'FREEZING DRIZZLE',
  61: 'LIGHT RAIN', 63: 'RAIN', 65: 'HEAVY RAIN', 66: 'FREEZING RAIN', 67: 'FREEZING RAIN',
  71: 'LIGHT SNOW', 73: 'SNOW', 75: 'HEAVY SNOW', 77: 'SNOW GRAINS',
  80: 'RAIN SHOWERS', 81: 'RAIN SHOWERS', 82: 'VIOLENT SHOWERS', 85: 'SNOW SHOWERS', 86: 'SNOW SHOWERS',
  95: 'THUNDERSTORM', 96: 'THUNDERSTORM + HAIL', 99: 'THUNDERSTORM + HAIL',
};

let cache = { at: 0, data: null, pending: null };

function normalize(station, raw, simulated = false) {
  const c = raw.current;
  const d = raw.daily;
  return {
    id: station.id,
    simulated,
    observedAt: c.time,
    timezone: raw.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds,
    isDay: c.is_day === 1,
    condition: CONDITIONS[c.weather_code] || `CODE ${c.weather_code}`,
    weatherCode: c.weather_code,
    temperatureC: c.temperature_2m,
    feelsLikeC: c.apparent_temperature,
    humidityPct: c.relative_humidity_2m,
    precipitationMm: c.precipitation,
    cloudCoverPct: c.cloud_cover,
    pressureHpa: c.pressure_msl,
    windKt: c.wind_speed_10m,
    windDirDeg: c.wind_direction_10m,
    gustKt: c.wind_gusts_10m,
    highC: d?.temperature_2m_max?.[0] ?? null,
    lowC: d?.temperature_2m_min?.[0] ?? null,
    sunrise: d?.sunrise?.[0] ?? null,
    sunset: d?.sunset?.[0] ?? null,
  };
}

async function fetchLive() {
  const params = new URLSearchParams({
    latitude: STATIONS.map((s) => s.lat).join(','),
    longitude: STATIONS.map((s) => s.lon).join(','),
    current: CURRENT.join(','),
    daily: DAILY.join(','),
    timezone: 'auto',
    forecast_days: '1',
    wind_speed_unit: 'kn',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo answered HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : [body];
  return Object.fromEntries(STATIONS.map((s, i) => [s.id, normalize(s, list[i])]));
}

// Plausible, slowly drifting fake readings for offline demos.
function simulate() {
  const t = Date.now() / 600000;
  const base = { dortmund: 8, indianapolis: 10, 'menlo-park': 16, melbourne: 20 };
  return Object.fromEntries(STATIONS.map((s, i) => {
    const wave = (k) => Math.sin(t + i * 1.7 + k);
    const temp = +(base[s.id] + 4 * wave(0)).toFixed(1);
    return [s.id, {
      ...normalize(s, {
        timezone: 'UTC', utc_offset_seconds: 0,
        current: {
          time: new Date().toISOString().slice(0, 16), is_day: 1, weather_code: [0, 2, 3, 61][i],
          temperature_2m: temp, apparent_temperature: temp - 2, relative_humidity_2m: Math.round(65 + 20 * wave(1)),
          precipitation: 0, cloud_cover: Math.round(50 + 40 * wave(2)), pressure_msl: +(1013 + 9 * wave(3)).toFixed(1),
          wind_speed_10m: +(9 + 6 * wave(4)).toFixed(1), wind_direction_10m: Math.round((200 + 90 * wave(5) + 360) % 360),
          wind_gusts_10m: +(16 + 8 * wave(6)).toFixed(1),
        },
        daily: null,
      }, true),
    }];
  }));
}

export async function getWeather() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!cache.pending) {
    cache.pending = (async () => {
      try {
        const stations = await fetchLive();
        cache = { at: Date.now(), data: { fetchedAt: new Date().toISOString(), source: 'open-meteo', stations }, pending: null };
      } catch (err) {
        console.warn(`[weather] live data unavailable (${err.message}) - using SIMULATION`);
        // Keep the last good reading if we have one; otherwise simulate. Retry in 60 s.
        const data = cache.data || { fetchedAt: new Date().toISOString(), source: 'simulation', stations: simulate() };
        cache = { at: Date.now() - CACHE_MS + 60000, data, pending: null };
      }
      return cache.data;
    })();
  }
  return cache.pending;
}

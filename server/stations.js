// The four weather stations. This list is public metadata (names, codes);
// the weather readings themselves are what the permission system protects.
export const STATIONS = [
  {
    id: 'dortmund',
    timezone: 'Europe/Berlin',
    name: 'Dortmund',
    region: 'North Rhine-Westphalia',
    country: 'Germany',
    icao: 'EDLW',
    lat: 51.5136,
    lon: 7.4653,
    customerSelectable: false, // HQ station: admin only, not offered on the customer page
  },
  {
    id: 'indianapolis',
    timezone: 'America/Indiana/Indianapolis',
    name: 'Indianapolis',
    region: 'Indiana',
    country: 'USA',
    icao: 'KIND',
    lat: 39.7684,
    lon: -86.1581,
    customerSelectable: true,
  },
  {
    id: 'menlo-park',
    timezone: 'America/Los_Angeles',
    name: 'Menlo Park',
    region: 'California',
    country: 'USA',
    icao: 'KPAO',
    lat: 37.453,
    lon: -122.1817,
    customerSelectable: true,
  },
  {
    id: 'melbourne',
    timezone: 'Australia/Melbourne',
    name: 'Melbourne',
    region: 'Victoria',
    country: 'Australia',
    icao: 'YMML',
    lat: -37.8136,
    lon: 144.9631,
    customerSelectable: true,
  },
];

export const STATION_IDS = STATIONS.map((s) => s.id);

export function publicStations() {
  return STATIONS.map(({ id, name, region, country, icao, timezone, customerSelectable }) => ({
    id, name, region, country, icao, timezone, customerSelectable,
  }));
}

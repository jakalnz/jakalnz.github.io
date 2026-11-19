// Overhead Now data relay — a Cloudflare Worker.
// The free flight feeds don't allow direct calls from other websites (no CORS),
// so this tiny worker fetches them and hands the result to the page.
// Only answers /point/{lat}/{lon}/{radius_nm}; it is not an open proxy.

const ALLOWED_ORIGINS = ['https://jakalnz.github.io'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// OpenSky returns arrays; convert to the readsb-style objects the page expects.
function fromOpenSky(d) {
  return (d.states || []).filter(s => s[5] != null && s[6] != null).map(s => ({
    hex: s[0], flight: s[1] || '', lon: s[5], lat: s[6],
    alt_baro: s[8] ? 'ground' : (s[7] != null ? s[7] / 0.3048 : undefined),
    alt_geom: s[13] != null ? s[13] / 0.3048 : undefined,
    gs: s[9] != null ? s[9] * 1.94384 : undefined, track: s[10] ?? undefined,
    baro_rate: s[11] != null ? s[11] * 196.85 : undefined, squawk: s[14] || undefined,
    category: s[17] === 8 ? 'A7' : undefined, seen: d.time && s[4] ? d.time - s[4] : undefined,
  }));
}

const UPSTREAMS = [
  { name: 'adsb.lol', tries: 3, url: (la, lo, nm) => `https://api.adsb.lol/v2/point/${la}/${lo}/${nm}` },
  { name: 'adsb.fi', tries: 1, url: (la, lo, nm) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'OpenSky', tries: 1, url: (la, lo, nm) => {
      const dLat = nm / 60, dLon = nm / (60 * Math.max(Math.cos(la * Math.PI / 180), 0.1));
      return `https://opensky-network.org/api/states/all?extended=1&lamin=${(+la - dLat).toFixed(3)}&lamax=${(+la + dLat).toFixed(3)}&lomin=${(+lo - dLon).toFixed(3)}&lomax=${(+lo + dLon).toFixed(3)}`;
    }, convert: fromOpenSky },
];

// Last good answer per area, reused briefly if every feed is busy.
const lastGood = new Map();

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const okOrigin = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const m = new URL(request.url).pathname.match(/^\/point\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)\/(\d{1,3})$/);
    if (!m) return new Response('Overhead Now relay. Use /point/{lat}/{lon}/{radius_nm}', { status: 404, headers: cors });

    const la = (+m[1]).toFixed(3), lo = (+m[2]).toFixed(3), nm = Math.min(Math.max(+m[3], 1), 100);
    const key = `${la},${lo},${nm}`;
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const errors = [];

    for (const up of UPSTREAMS) {
      for (let i = 0; i < up.tries; i++) {
        try {
          const r = await fetch(up.url(la, lo, nm), { headers: { 'User-Agent': 'overhead-now-relay' } });
          if (r.status === 429 && i < up.tries - 1) { await sleep(400 * (i + 1)); continue; }
          if (!r.ok) { errors.push(`${up.name} HTTP ${r.status}`); break; }
          const d = await r.json();
          const ac = up.convert ? up.convert(d) : (d.ac || d.aircraft || []);
          const out = { source: up.name, now: Date.now(), ac };
          lastGood.set(key, out);
          return json(out);
        } catch (e) { errors.push(`${up.name}: ${e.message}`); break; }
      }
    }
    const prev = lastGood.get(key);
    if (prev && Date.now() - prev.now < 60000) return json({ ...prev, stale: true, source: prev.source + ' (cached)' });
    return json({ error: errors.join('; ') }, 502);
  },
};

// Overhead Now data relay — a Cloudflare Worker.
// The free flight feeds don't allow direct calls from other websites (no CORS),
// so this tiny worker fetches them and hands the result to the page.
// Only answers /point/{lat}/{lon}/{radius_nm}; it is not an open proxy.

const ALLOWED_ORIGINS = ['https://jakalnz.github.io'];

const UPSTREAMS = [
  { name: 'adsb.fi',  url: (la, lo, nm) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'adsb.lol', url: (la, lo, nm) => `https://api.adsb.lol/v2/point/${la}/${lo}/${nm}` },
];

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
    let lastError = 'no upstream answered';
    for (const up of UPSTREAMS) {
      try {
        const r = await fetch(up.url(la, lo, nm), { headers: { 'User-Agent': 'overhead-now-relay' } });
        if (!r.ok) { lastError = `${up.name} HTTP ${r.status}`; continue; }
        const d = await r.json();
        const body = JSON.stringify({ source: up.name, now: d.now, ac: d.ac || d.aircraft || [] });
        return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) { lastError = `${up.name}: ${e.message}`; }
    }
    return new Response(JSON.stringify({ error: lastError }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};

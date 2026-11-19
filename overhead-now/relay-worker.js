// Overhead Now data relay — a Cloudflare Worker.
// The free flight feeds don't allow direct calls from other websites (no CORS),
// so this worker fetches them and hands the result to the page.
//
// Track replay: every answer the worker fetches for the app is also handed to a
// small store (a Durable Object) that keeps two hours of positions. It makes no
// extra requests of its own, so replay covers the times the app was open.
//
// Routes: /point/{lat}/{lon}/{radius_nm}   /history/{hex}?mins=60   /recorder-status
// It is not an open proxy.

const ALLOWED_ORIGINS = ['https://jakalnz.github.io'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEEP_MS = 2 * 3600_000;          // how much history to keep

// adsb.fi, airplanes.live and OpenSky all refuse or time out from Cloudflare, so only adsb.lol is used.
async function fetchAircraft(la, lo, nm, errors = []) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.adsb.lol/v2/point/${la}/${lo}/${nm}`,
        { headers: { 'User-Agent': 'overhead-now-relay' }, signal: AbortSignal.timeout(8000) });
      if (r.status === 429 && i < 2) { await sleep(400 * (i + 1)); continue; }
      if (!r.ok) { errors.push(`adsb.lol HTTP ${r.status}`); return null; }
      const d = await r.json();
      return { source: 'adsb.lol', ac: d.ac || d.aircraft || [] };
    } catch (e) { errors.push(`adsb.lol: ${e.message}`); return null; }
  }
  return null;
}

// Compact snapshot: hex -> [lat, lon, alt ft | 'ground' | null, track, ground speed kt]
function compact(ac) {
  const snap = {};
  for (const a of ac) {
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || !a.hex) continue;
    const alt = a.alt_baro === 'ground' ? 'ground' : (typeof a.alt_baro === 'number' ? Math.round(a.alt_baro) : null);
    snap[a.hex.toLowerCase()] = [+a.lat.toFixed(5), +a.lon.toFixed(5), alt,
      typeof a.track === 'number' ? Math.round(a.track) : null, typeof a.gs === 'number' ? Math.round(a.gs) : null];
  }
  return snap;
}

const store = (rec, ac) => rec.fetch('https://rec/store', { method: 'POST', body: JSON.stringify(compact(ac)) }).catch(() => {});

// Last good answer per area, reused briefly if the feed is busy.
const lastGood = new Map();

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const okOrigin = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const rec = env.REC ? env.REC.get(env.REC.idFromName('recorder-2')) : null;

    const h = url.pathname.match(/^\/history\/([0-9a-f]{6})$/i);
    if (h) {
      if (!rec) return json({ path: [] });
      const mins = Math.min(Math.max(parseInt(url.searchParams.get('mins') || '60', 10) || 60, 1), 120);
      return json(await (await rec.fetch(`https://rec/history/${h[1].toLowerCase()}?mins=${mins}`)).json());
    }
    if (url.pathname === '/recorder-status' && rec) return json(await (await rec.fetch('https://rec/status')).json());

    const m = url.pathname.match(/^\/point\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)\/(\d{1,3})$/);
    if (!m) return new Response('Overhead Now relay. Use /point/{lat}/{lon}/{radius_nm} or /history/{hex}', { status: 404, headers: cors });

    const la = (+m[1]).toFixed(3), lo = (+m[2]).toFixed(3), nm = Math.min(Math.max(+m[3], 1), 100);

    const key = `${la},${lo},${nm}`;
    const errors = [];
    const got = await fetchAircraft(la, lo, nm, errors);
    if (got) {
      const out = { source: got.source, now: Date.now(), ac: got.ac };
      lastGood.set(key, out);
      if (rec) ctx.waitUntil(store(rec, got.ac));
      return json(out);
    }
    const prev = lastGood.get(key);
    if (prev && Date.now() - prev.now < 60000) return json({ ...prev, stale: true, source: prev.source + ' (cached)' });
    return json({ error: errors.join('; ') }, 502);
  },
};

// Stores snapshots and answers history questions. Makes no outside requests.
export class Recorder {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS snaps (t INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    switch (url.pathname) {
      case '/touch': {
        const la = +url.searchParams.get('la'), lo = +url.searchParams.get('lo');
        if (Number.isFinite(la) && Number.isFinite(lo)) await this.state.storage.put('area', { la, lo });
        await this.state.storage.put('lastUse', now);
        await this.state.storage.deleteAlarm(); // earlier versions sampled from here; no longer needed
        return new Response('ok');
      }
      case '/store': {
        const snap = await request.json();
        // Merge into a sample taken in the same 10 s window, so app and schedule samples don't double up.
        const slot = Math.round(now / 10_000) * 10_000;
        const prev = [...this.sql.exec('SELECT data FROM snaps WHERE t = ?', slot)][0];
        const data = prev ? { ...JSON.parse(prev.data), ...snap } : snap;
        this.sql.exec('INSERT OR REPLACE INTO snaps (t, data) VALUES (?, ?)', slot, JSON.stringify(data));
        this.sql.exec('DELETE FROM snaps WHERE t < ?', now - KEEP_MS);
        await this.state.storage.put('lastStore', now);
        return new Response('ok');
      }
      case '/cron':
        await this.state.storage.put('lastCron', { t: now, ...(await request.json()) });
        return new Response('ok');
      case '/error':
        await this.state.storage.put('lastError', { t: now, errors: await request.json() });
        return new Response('ok');
      case '/status': {
        const n = [...this.sql.exec('SELECT COUNT(*) AS n, MIN(t) AS a, MAX(t) AS b FROM snaps')][0];
        return Response.json({ snapshots: n.n, oldest: n.a, newest: n.b, area: await this.state.storage.get('area'),
          lastUse: await this.state.storage.get('lastUse'), lastError: await this.state.storage.get('lastError'),
          lastCron: await this.state.storage.get('lastCron'), now });
      }
    }
    const h = url.pathname.match(/^\/history\/([0-9a-f]{6})$/);
    if (h) {
      const since = now - (+url.searchParams.get('mins') || 60) * 60_000;
      const path = [];
      for (const row of this.sql.exec('SELECT t, data FROM snaps WHERE t >= ? ORDER BY t', since)) {
        const p = JSON.parse(row.data)[h[1]];
        if (p) path.push([row.t, ...p]); // [time ms, lat, lon, alt ft | 'ground' | null, track, ground speed kt]
      }
      const first = [...this.sql.exec('SELECT MIN(t) AS a FROM snaps')][0];
      return Response.json({ source: 'recorder', path, recordedSince: first.a });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {} // earlier versions sampled on an alarm; does nothing now and does not reschedule
}

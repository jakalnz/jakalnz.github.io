// Overhead Now data relay — a Cloudflare Worker.
// The free flight feeds don't allow direct calls from other websites (no CORS),
// so this worker fetches them and hands the result to the page.
//
// Track replay: every answer the worker fetches for the app is also handed to a
// small store (a Durable Object) that keeps two hours of positions. It makes no
// extra requests of its own, so replay covers the times the app was open.
//
// Ships: AIS positions come from aisstream.io over a WebSocket held by a second Durable Object (Ships).
// It needs a free API key stored as the secret AISSTREAM_KEY and a binding named SHIPS (see the bottom of this file).
// Without them the /ships route just answers "not configured" and aircraft keep working.
//
// Routes: /point/{lat}/{lon}/{radius_nm}   /history/{hex}?mins=60   /ships/{lat}/{lon}/{radius_km}   /recorder-status
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

    const sh = url.pathname.match(/^\/ships\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)\/(\d{1,3})$/);
    if (sh) {
      if (!env.SHIPS || !env.AISSTREAM_KEY) return json({ configured: false, ships: [] });
      const la = (+sh[1]).toFixed(3), lo = (+sh[2]).toFixed(3), km = Math.min(Math.max(+sh[3], 1), 60);
      try {
        const stub = env.SHIPS.get(env.SHIPS.idFromName('ships-7'));
        return json(await (await stub.fetch(`https://ships/query?la=${la}&lo=${lo}&km=${km}`)).json());
      } catch (e) { return json({ configured: true, ships: [], error: String(e.message || e) }, 502); }
    }

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

// ---------------------------------------------------------------------------
// Ships. One Durable Object keeps a WebSocket open to aisstream.io for the area the app is looking at,
// holds the latest position and details of each vessel in memory, and answers /query.
// The socket is closed after 30 minutes with no requests, so it only runs while the app is in use.
//
// Setup (Cloudflare dashboard or wrangler):
//   1. Free API key from https://aisstream.io  ->  add as a secret named AISSTREAM_KEY
//   2. Durable Object binding named SHIPS pointing at class Ships
//   3. Migration:  [[migrations]] tag = "v2"  new_classes = ["Ships"]
// ---------------------------------------------------------------------------
const SHIP_STALE_MS = 30 * 60_000;   // forget a vessel not heard from for this long
const STATIC_KEEP_MS = 14 * 86400_000; // remember a vessel's destination, size and type for two weeks
const SHIP_IDLE_MS = 30 * 60_000;    // keep listening this long after the last request, so ships are already there when the app reopens
const kmBetween = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export class Ships {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.ships = new Map();    // mmsi -> latest position report
    this.statics = new Map();  // mmsi -> name, type, destination, size... (kept in storage: ships only send these every few minutes)
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS statics (mmsi TEXT PRIMARY KEY, t INTEGER NOT NULL, data TEXT NOT NULL)');
    for (const r of this.sql.exec('SELECT mmsi, data FROM statics')) this.statics.set(r.mmsi, JSON.parse(r.data));
    this.ws = null; this.box = null; this.connecting = null;
    this.lastUse = 0; this.openedAt = 0; this.error = null;
  }

  async fetch(request) {
    const u = new URL(request.url);
    const la = +u.searchParams.get('la'), lo = +u.searchParams.get('lo'), km = +u.searchParams.get('km');
    if (![la, lo, km].every(Number.isFinite)) return new Response('bad request', { status: 400 });
    this.lastUse = Date.now();
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(this.lastUse + SHIP_IDLE_MS);
    try { await this.ensure(la, lo, km); } catch (e) { this.error = String(e.message || e); }

    const now = Date.now(), out = [];
    for (const [mmsi, s] of this.ships) {
      if (now - s.t > SHIP_STALE_MS) { this.ships.delete(mmsi); continue; }
      const d = kmBetween(la, lo, s.lat, s.lon);
      if (d > km) continue;
      const st = this.statics.get(mmsi) || {};
      out.push({ mmsi, name: s.name || st.name || null, lat: s.lat, lon: s.lon, sog: s.sog, cog: s.cog, hdg: s.hdg, nav: s.nav,
        type: st.type ?? null, dest: st.dest || null, imo: st.imo || null, call: st.call || null,
        len: st.len || null, beam: st.beam || null, draught: st.draught || null, age: Math.round((now - s.t) / 1000), d });
    }
    out.sort((a, b) => a.d - b.d);
    return Response.json({ configured: true, now, ships: out.slice(0, 300).map(({ d, ...rest }) => rest),
      listening: !!this.ws, listeningFor: this.ws ? Math.round((now - this.openedAt) / 1000) : 0,
      error: this.error });
  }

  // Make sure the feed is open and its box covers the circle the app asked about.
  async ensure(la, lo, km) {
    const b = this.box;
    const dLa = km / 111, dLo = km / (111 * Math.max(Math.cos(la * Math.PI / 180), 0.05));
    const covered = this.ws && b && la - dLa >= b.s && la + dLa <= b.n && lo - dLo >= b.w && lo + dLo <= b.e;
    if (covered) return;
    if (!this.connecting) this.connecting = this.connect(la, lo, km).finally(() => { this.connecting = null; });
    await this.connecting;
  }

  async connect(la, lo, km) {
    try { this.ws?.close(1000, 'new area'); } catch (e) {}
    this.ws = null;
    const r = Math.min(Math.max(km * 1.5, 30), 100); // listen a little wider than asked so small moves don't reconnect
    const dLa = r / 111, dLo = r / (111 * Math.max(Math.cos(la * Math.PI / 180), 0.05));
    const box = { s: Math.max(la - dLa, -90), n: Math.min(la + dLa, 90), w: Math.max(lo - dLo, -180), e: Math.min(lo + dLo, 180) };
    const resp = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) throw new Error(`aisstream.io refused the connection (HTTP ${resp.status})`);
    ws.accept();
    // aisstream wants the subscription within 3 seconds of connecting.
    ws.send(JSON.stringify({
      APIKey: this.env.AISSTREAM_KEY,
      BoundingBoxes: [[[box.s, box.w], [box.n, box.e]]],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData', 'StaticDataReport'],
    }));
    ws.addEventListener('message', ev => this.onMessage(ev.data));
    const gone = msg => { if (this.ws === ws) { this.ws = null; this.box = null; if (msg) this.error = msg; } };
    ws.addEventListener('close', ev => gone(ev.code === 1000 ? null : `aisstream.io closed the feed (${ev.code} ${ev.reason || ''})`.trim()));
    ws.addEventListener('error', () => gone('aisstream.io feed error'));
    this.ws = ws; this.box = box; this.openedAt = Date.now(); this.error = null;
  }

  async onMessage(raw) {
    if (typeof raw !== 'string') raw = typeof raw.text === 'function' ? await raw.text() : new TextDecoder().decode(raw); // aisstream sends binary frames
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.error || m.Error) { this.error = String(m.error || m.Error); return; } // e.g. invalid API key
    const md = m.MetaData || {}, mmsi = String(md.MMSI || '');
    const body = m.Message && m.Message[m.MessageType];
    if (!mmsi || !body) return;
    const clean = v => (typeof v === 'string' ? v.replace(/[@\s]+$/, '').trim() : '');
    const merge = (patch) => {
      const prev = this.statics.get(mmsi) || {};
      for (const k of Object.keys(patch)) if (patch[k] !== undefined && patch[k] !== '' && patch[k] !== null) prev[k] = patch[k];
      prev.t = Date.now();
      this.statics.set(mmsi, prev);
      this.sql.exec('INSERT OR REPLACE INTO statics (mmsi, t, data) VALUES (?, ?, ?)', mmsi, prev.t, JSON.stringify(prev));
    };
    const size = d => d && (d.A || d.B) ? { len: (d.A || 0) + (d.B || 0), beam: (d.C || 0) + (d.D || 0) } : {};
    switch (m.MessageType) {
      case 'PositionReport':
      case 'StandardClassBPositionReport': {
        const lat = body.Latitude ?? md.latitude, lon = body.Longitude ?? md.longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) return; // 91 / 181 mean "not available"
        const prev = this.ships.get(mmsi) || {};
        this.ships.set(mmsi, { ...prev, lat, lon, t: Date.now(),
          name: clean(md.ShipName) || prev.name || null,
          sog: typeof body.Sog === 'number' && body.Sog < 102.3 ? body.Sog : null,
          cog: typeof body.Cog === 'number' && body.Cog < 360 ? body.Cog : null,
          hdg: typeof body.TrueHeading === 'number' && body.TrueHeading < 360 ? body.TrueHeading : null,
          nav: typeof body.NavigationalStatus === 'number' ? body.NavigationalStatus : null });
        break;
      }
      case 'ShipStaticData':
        merge({ name: clean(body.Name), type: body.Type, dest: clean(body.Destination), imo: body.ImoNumber || undefined,
          call: clean(body.CallSign), draught: body.MaximumStaticDraught || undefined, ...size(body.Dimension) });
        break;
      case 'StaticDataReport': // class B boats send this in two parts
        if (body.ReportA) merge({ name: clean(body.ReportA.Name) });
        if (body.ReportB) merge({ type: body.ReportB.ShipType, call: clean(body.ReportB.CallSign), ...size(body.ReportB.Dimension) });
        break;
    }
  }

  prune(now) {
    for (const [k, v] of this.statics) if (now - v.t > STATIC_KEEP_MS) this.statics.delete(k);
    this.sql.exec('DELETE FROM statics WHERE t < ?', now - STATIC_KEEP_MS);
  }

  async alarm() {
    const now = Date.now();
    if (now - this.lastUse >= SHIP_IDLE_MS) {
      try { this.ws?.close(1000, 'idle'); } catch (e) {}
      this.ws = null; this.box = null;
      this.ships.clear(); this.prune(now); // keep the stored vessel details for next time
      return; // no reschedule; the next request sets a new alarm
    }
    for (const [k, s] of this.ships) if (now - s.t > SHIP_STALE_MS) this.ships.delete(k);
    this.prune(now);
    await this.state.storage.setAlarm(this.lastUse + SHIP_IDLE_MS);
  }
}

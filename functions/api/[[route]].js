// Carpool Tracker — Cloudflare Pages Functions API (single file, catch-all route)
// Deployed as part of the SAME Pages project as the static frontend in /public.
// It talks to a D1 database bound as `DB` (see wrangler.toml / Pages settings).
//
// Optional shared group code:
//   Set an environment variable GROUP_CODE (Pages > Settings > Environment
//   variables, or `wrangler pages secret put GROUP_CODE`). If it is set, every
//   /api/* request must send header  X-Group-Code: <that code>. The frontend
//   asks once and remembers it on that device. If it is NOT set, the API is
//   open to anyone with the link — fine for a quick test, not recommended for
//   the shared link you hand out. No password is hardcoded here.
//
// Routes:
//   GET    /api/state                 full state (people, settings, rides, payments, noDriveDays)
//   GET    /api/summary               same totals the UI shows, computed server-side
//   GET    /api/settings              PUT /api/settings
//   GET    /api/people                POST /api/people
//   PUT    /api/people/:id            DELETE /api/people/:id
//   GET    /api/rides                 POST /api/rides
//   PUT    /api/rides/:id             DELETE /api/rides/:id
//   GET    /api/payments              POST /api/payments
//   PUT    /api/payments/:id          DELETE /api/payments/:id
//   GET    /api/no-drive              POST /api/no-drive {date}   DELETE /api/no-drive/:date

const DEFAULT_PEOPLE = [
  { name: "Nisarg", canDrive: true },
  { name: "Apurva", canDrive: true },
  { name: "Chetan", canDrive: false },
  { name: "Sai", canDrive: false },
  { name: "Aakash", canDrive: false },
];
const DEFAULT_SETTINGS = { rateCents: 500, officeDays: [2, 3, 4] }; // $5, Tue/Wed/Thu

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function fail(message, status = 400) { return json({ error: message }, status); }

function checkAuth(request, env) {
  const expected = env.GROUP_CODE || env.APP_PASSCODE || "";
  if (!expected) return null; // no code configured -> open (documented in README)
  const given = request.headers.get("x-group-code") || "";
  return given === expected ? null : fail("Missing or wrong group code. Enter the group code in the app.", 401);
}

async function ensureSeeded(db) {
  // Tables are created by schema.sql. Seed only when empty (idempotent).
  const count = await db.prepare("SELECT COUNT(*) AS n FROM people").first();
  if (count && count.n === 0) {
    const stmts = DEFAULT_PEOPLE.map((p) =>
      db.prepare("INSERT OR IGNORE INTO people (name, can_drive) VALUES (?, ?)").bind(p.name, p.canDrive ? 1 : 0)
    );
    await db.batch(stmts);
  }
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('rate_cents', ?)").bind(String(DEFAULT_SETTINGS.rateCents)).run();
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('office_days', ?)").bind(JSON.stringify(DEFAULT_SETTINGS.officeDays)).run();
}

async function getSettings(db) {
  const rows = await db.prepare("SELECT key, value FROM settings").all();
  const map = {};
  for (const r of rows.results || []) { try { map[r.key] = JSON.parse(r.value); } catch { map[r.key] = r.value; } }
  return {
    rateCents: Number.isInteger(map.rate_cents) ? map.rate_cents : DEFAULT_SETTINGS.rateCents,
    officeDays: Array.isArray(map.office_days) ? map.office_days : DEFAULT_SETTINGS.officeDays,
  };
}

async function getState(db) {
  await ensureSeeded(db);
  const people = (await db.prepare("SELECT id, name, can_drive FROM people ORDER BY id").all()).results
    .map((p) => ({ id: p.id, name: p.name, canDrive: !!p.can_drive }));
  const ridesRaw = (await db.prepare("SELECT id, date, direction, driver_id, rate_cents FROM rides ORDER BY date DESC, id DESC").all()).results;
  const riderRows = (await db.prepare("SELECT ride_id, person_id FROM ride_riders").all()).results;
  const ridersByRide = new Map();
  for (const r of riderRows) {
    if (!ridersByRide.has(r.ride_id)) ridersByRide.set(r.ride_id, []);
    ridersByRide.get(r.ride_id).push(r.person_id);
  }
  const rides = ridesRaw.map((r) => ({
    id: r.id, date: r.date, direction: r.direction, driverId: r.driver_id,
    rateCents: r.rate_cents, riderIds: ridersByRide.get(r.id) || [],
  }));
  const payments = (await db.prepare("SELECT id, from_person_id, to_person_id, amount_cents, date, note FROM payments ORDER BY date DESC, id DESC").all()).results
    .map((p) => ({ id: p.id, fromId: p.from_person_id, toId: p.to_person_id, amountCents: p.amount_cents, date: p.date, note: p.note || "" }));
  const noDriveDays = (await db.prepare("SELECT date FROM no_drive_days ORDER BY date").all()).results.map((r) => r.date);
  const settings = await getSettings(db);
  return { people, settings, rides, payments, noDriveDays };
}

// Pairwise netting: positive remaining for pair (a,b) means a still owes b.
// Overpayment flips the sign, which the UI presents as a credit the other way.
function computeSummary(state) {
  const byId = new Map(state.people.map((p) => [p.id, { ...p, drove: 0, rode: 0, earnedCents: 0, owedCents: 0, paidCents: 0, receivedCents: 0 }]));
  const pair = new Map(); // "lowId|highId" -> cents lowId owes highId (can go negative)
  const addPair = (fromId, toId, cents) => {
    if (fromId === toId || !cents) return;
    const low = Math.min(fromId, toId), high = Math.max(fromId, toId), key = `${low}|${high}`;
    pair.set(key, (pair.get(key) || 0) + (fromId === low ? cents : -cents));
  };
  for (const ride of state.rides) {
    const driver = byId.get(ride.driverId); if (driver) driver.drove += 1;
    for (const riderId of ride.riderIds) {
      const rider = byId.get(riderId); if (!rider) continue;
      rider.rode += 1; rider.owedCents += ride.rateCents;
      if (driver) driver.earnedCents += ride.rateCents;
      addPair(riderId, ride.driverId, ride.rateCents);
    }
  }
  for (const pay of state.payments) {
    const from = byId.get(pay.fromId), to = byId.get(pay.toId);
    if (from) from.paidCents += pay.amountCents;
    if (to) to.receivedCents += pay.amountCents;
    addPair(pay.fromId, pay.toId, -pay.amountCents);
  }
  const owes = [];
  for (const [key, cents] of pair) {
    if (!cents) continue;
    const [low, high] = key.split("|").map(Number);
    if (cents > 0) owes.push({ fromId: low, toId: high, remainingCents: cents });
    else owes.push({ fromId: high, toId: low, remainingCents: -cents });
  }
  owes.sort((a, b) => b.remainingCents - a.remainingCents);
  const people = [...byId.values()].map((p) => {
    let stillOwes = 0, stillReceives = 0;
    for (const o of owes) {
      if (o.fromId === p.id) stillOwes += o.remainingCents;
      if (o.toId === p.id) stillReceives += o.remainingCents;
    }
    return { ...p, stillOwesCents: stillOwes, stillReceivesCents: stillReceives, netCents: stillReceives - stillOwes };
  });
  return { people, owes };
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isIdList = (a) => Array.isArray(a) && a.every((n) => Number.isInteger(n));

async function replaceRiders(db, rideId, riderIds) {
  const stmts = [db.prepare("DELETE FROM ride_riders WHERE ride_id = ?").bind(rideId)];
  for (const pid of [...new Set(riderIds)]) stmts.push(db.prepare("INSERT INTO ride_riders (ride_id, person_id) VALUES (?, ?)").bind(rideId, pid));
  await db.batch(stmts);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!env.DB) return fail("D1 database is not bound. Bind your D1 database as DB in the Pages project settings.", 500);
  const authFail = checkAuth(request, env);
  if (authFail) return authFail;

  const db = env.DB;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [resource, idPart] = parts;
  const id = idPart ? Number(idPart) : null;
  const method = request.method;

  try {
    if (method === "GET" && (parts.length === 0 || resource === "state")) return json(await getState(db));
    if (method === "GET" && resource === "summary") { const s = await getState(db); return json({ settings: s.settings, ...computeSummary(s) }); }

    if (resource === "settings") {
      if (method === "GET") return json(await getSettings(db));
      if (method === "PUT") {
        const b = await readBody(request); const cur = await getSettings(db);
        const rateCents = Number.isInteger(b.rateCents) ? b.rateCents : (typeof b.rate === "number" ? Math.round(b.rate * 100) : cur.rateCents);
        const officeDays = Array.isArray(b.officeDays) ? b.officeDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : cur.officeDays;
        if (rateCents < 0) return fail("Rate cannot be negative.");
        await db.batch([
          db.prepare("INSERT INTO settings (key, value) VALUES ('rate_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(rateCents)),
          db.prepare("INSERT INTO settings (key, value) VALUES ('office_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(officeDays)),
        ]);
        return json(await getSettings(db));
      }
    }

    if (resource === "people") {
      if (method === "GET") return json((await getState(db)).people);
      if (method === "POST") {
        const b = await readBody(request);
        if (!b.name || !String(b.name).trim()) return fail("Name is required.");
        const r = await db.prepare("INSERT INTO people (name, can_drive) VALUES (?, ?)").bind(String(b.name).trim(), b.canDrive ? 1 : 0).run();
        return json({ id: r.meta.last_row_id, name: String(b.name).trim(), canDrive: !!b.canDrive }, 201);
      }
      if (id && method === "PUT") {
        const b = await readBody(request);
        if (!b.name || !String(b.name).trim()) return fail("Name is required.");
        await db.prepare("UPDATE people SET name = ?, can_drive = ? WHERE id = ?").bind(String(b.name).trim(), b.canDrive ? 1 : 0, id).run();
        return json({ id, name: String(b.name).trim(), canDrive: !!b.canDrive });
      }
      if (id && method === "DELETE") {
        const used = await db.prepare("SELECT (SELECT COUNT(*) FROM rides WHERE driver_id = ?) + (SELECT COUNT(*) FROM ride_riders WHERE person_id = ?) + (SELECT COUNT(*) FROM payments WHERE from_person_id = ? OR to_person_id = ?) AS n").bind(id, id, id, id).first();
        if (used && used.n > 0) return fail("This person has rides or payments in history, so they can't be removed without erasing the audit trail. Rename them instead, or delete their rides/payments first.", 409);
        await db.prepare("DELETE FROM people WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    if (resource === "rides") {
      if (method === "GET") return json((await getState(db)).rides);
      if (method === "POST" || (id && method === "PUT")) {
        const b = await readBody(request);
        if (!isDate(b.date)) return fail("A valid date (YYYY-MM-DD) is required.");
        if (!["to_office", "return"].includes(b.direction)) return fail("Direction must be 'to_office' or 'return'.");
        if (!Number.isInteger(b.driverId)) return fail("Pick a driver.");
        if (!isIdList(b.riderIds || [])) return fail("Riders must be a list of people.");
        const riderIds = (b.riderIds || []).filter((pid) => pid !== b.driverId);
        let rideId = id;
        if (method === "POST") {
          const settings = await getSettings(db);
          const r = await db.prepare("INSERT INTO rides (date, direction, driver_id, rate_cents) VALUES (?, ?, ?, ?)").bind(b.date, b.direction, b.driverId, Number.isInteger(b.rateCents) ? b.rateCents : settings.rateCents).run();
          rideId = r.meta.last_row_id;
        } else {
          await db.prepare("UPDATE rides SET date = ?, direction = ?, driver_id = ? WHERE id = ?").bind(b.date, b.direction, b.driverId, id).run();
        }
        await replaceRiders(db, rideId, riderIds);
        await db.prepare("DELETE FROM no_drive_days WHERE date = ?").bind(b.date).run(); // logging a ride un-marks a no-drive day
        return json({ id: rideId }, method === "POST" ? 201 : 200);
      }
      if (id && method === "DELETE") {
        await db.batch([db.prepare("DELETE FROM ride_riders WHERE ride_id = ?").bind(id), db.prepare("DELETE FROM rides WHERE id = ?").bind(id)]);
        return json({ ok: true });
      }
    }

    if (resource === "payments") {
      if (method === "GET") return json((await getState(db)).payments);
      if (method === "POST" || (id && method === "PUT")) {
        const b = await readBody(request);
        const amountCents = Number.isInteger(b.amountCents) ? b.amountCents : (typeof b.amount === "number" ? Math.round(b.amount * 100) : null);
        if (!Number.isInteger(b.fromId) || !Number.isInteger(b.toId) || b.fromId === b.toId) return fail("Pick who paid and who received — they must be different people.");
        if (!amountCents || amountCents <= 0) return fail("Enter a payment amount above $0.");
        if (!isDate(b.date)) return fail("A valid date (YYYY-MM-DD) is required.");
        if (method === "POST") {
          const r = await db.prepare("INSERT INTO payments (from_person_id, to_person_id, amount_cents, date, note) VALUES (?, ?, ?, ?, ?)").bind(b.fromId, b.toId, amountCents, b.date, String(b.note || "")).run();
          return json({ id: r.meta.last_row_id }, 201);
        }
        await db.prepare("UPDATE payments SET from_person_id = ?, to_person_id = ?, amount_cents = ?, date = ?, note = ? WHERE id = ?").bind(b.fromId, b.toId, amountCents, b.date, String(b.note || ""), id).run();
        return json({ id });
      }
      if (id && method === "DELETE") { await db.prepare("DELETE FROM payments WHERE id = ?").bind(id).run(); return json({ ok: true }); }
    }

    if (resource === "no-drive") {
      if (method === "GET") return json((await getState(db)).noDriveDays);
      if (method === "POST") {
        const b = await readBody(request);
        if (!isDate(b.date)) return fail("A valid date (YYYY-MM-DD) is required.");
        await db.prepare("INSERT OR IGNORE INTO no_drive_days (date) VALUES (?)").bind(b.date).run();
        return json({ ok: true, date: b.date }, 201);
      }
      if (method === "DELETE") {
        const b = idPart && isDate(idPart) ? { date: idPart } : await readBody(request);
        if (!isDate(b.date)) return fail("A valid date (YYYY-MM-DD) is required.");
        await db.prepare("DELETE FROM no_drive_days WHERE date = ?").bind(b.date).run();
        return json({ ok: true });
      }
    }

    return fail("Not found.", 404);
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) return fail("That name is already used. Names must be unique.", 409);
    return fail(`Server error: ${err && err.message ? err.message : err}`, 500);
  }
}

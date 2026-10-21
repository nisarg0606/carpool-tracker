# Carpool Tracker — shared live version (one deployment)

One **Cloudflare Pages project** = one deployment, one link, free:

- `public/` — the app itself (a single-page page, no build step)
- `functions/api/` — a Pages Functions API, deployed *inside the same Pages project*
- A **D1 database binding** on that same project — that's the shared storage.
  It is not a separate backend server: there's nothing else to run, host, or maintain.
  Everyone who opens the one `*.pages.dev` link sees the same rides, balances, and payments.

## What's in this folder

| File | What it is |
|---|---|
| `public/index.html` | The whole app: Log ride / Balances + Record Payment / History / People & settings. Talks to `/api/*`. |
| `functions/api/[[route]].js` | The whole JSON API (people, settings, rides, payments, no-drive days, summary), backed by D1 via the `DB` binding. |
| `schema.sql` | D1 tables: `people`, `settings`, `rides`, `ride_riders`, `payments`, `no_drive_days`. Also inserts the default settings and starting roster. |
| `wrangler.toml` | Example Pages config with the D1 binding placeholder. |
| `README.md` | This deploy guide. |

Money rules in the app: **$5 per rider per one-way ride to that ride's driver** (the rate is editable
in Settings and applies going forward — old rides keep the rate they were logged at). No percentage
splits anywhere. Payments are separate records: a full payment zeroes a pair's balance, a partial
payment reduces it, and ride history stays untouched/auditable.

## Deploy steps (free — using your existing Cloudflare account)

You already have a Cloudflare account, so there's no signup below — just sign in to it.

### 1. Sign in

Go to <https://dash.cloudflare.com> and sign in to your existing account.

### 2. Create the D1 database

1. In the left sidebar: **Storage & Databases → D1 SQL Database → Create database**.
2. Name it `carpool-tracker` and create it.
3. Keep its **database ID** handy — you need it in step 4 if you deploy with wrangler
   (paste it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

### 3. Create the tables (run the schema)

On the database's page, open **Console**, paste in the entire contents of `schema.sql`,
and run it. (This also adds the default $5 rate, Tue/Wed/Thu office days, and the starting
roster: Nisarg and Apurva can drive; Chetan, Sai, Aakash are riders — all editable in the app.)

Command-line alternative, from this folder:

```bash
npx wrangler login
npx wrangler d1 execute carpool-tracker --remote --file=./schema.sql
```

### 4. Create the Pages project (the one deployment)

**Option A — wrangler (fastest, from this folder):**

```bash
npx wrangler pages deploy --project-name carpool-tracker
```

`wrangler.toml` already points the build output at `public/`, and Pages automatically picks up
`functions/` from this folder, so the site and the API ship together in that one deploy.

**Option B — dashboard + GitHub:**

1. Push this folder to a GitHub repo.
2. In Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**, pick the repo.
3. Framework preset: **None**. Build command: *(leave empty)*. Build output directory: `public`.
   Root directory: this folder, if it's not the repo root.
4. **Save and Deploy.** Pages detects `functions/` on its own — the API is part of the same project.

**Option C — dashboard drag-and-drop:** In **Workers & Pages → Create → Pages → Upload assets**,
create the project and upload the contents of this folder. If the API doesn't respond after this
route, use Option A instead — the Functions folder must be preserved in the upload.

### 5. Bind the database to the project (this is what makes it shared)

1. Open the Pages project → **Settings → Bindings** (older dashboards: **Settings → Functions →
   D1 database bindings**) → **Add**.
2. Variable name: **`DB`** (must be exactly `DB` — the API reads `env.DB`).
3. Pick the `carpool-tracker` D1 database, save.
4. If you deployed before adding the binding, **redeploy once** (Deployments → ⋯ → Retry deployment,
   or run the Option A command again) so the binding takes effect.

If you deploy with wrangler, the `[[d1_databases]]` block in `wrangler.toml` (with your real
database ID filled in) does this step for you.

### 6. Recommended: set a shared group code

Without a code, anyone who has the link can view and edit the tracker. A group code is one shared
word/phrase the whole carpool enters once per device — it's a light lock, not individual accounts.

Dashboard: Pages project → **Settings → Environment variables → Add** —
name `GROUP_CODE`, value = a code you choose, for **Production**. Redeploy once.

Or: `npx wrangler pages secret put GROUP_CODE --project-name carpool-tracker`

Don't commit the real code into `wrangler.toml` or any other file. When someone opens the app,
it asks for the code once and remembers it on that device.

### 7. Share the link

Your project gets a link like `https://carpool-tracker.pages.dev`. Send that **one link** to
Apurva, Chetan, Sai, and Aakash (plus the group code, if you set one). Anyone can log a ride or
record a payment from that link and everyone else sees it — same live data for all.

## Everyday use (30 seconds)

- **Log ride:** pick the date → *To office* or *Coming back* → tap who drove → tap who rode along → Save.
  Do the same again for the other direction — they're logged as separate rides on purpose, because
  the riders usually differ.
- **No drive today:** one button on the Log screen marks the whole day off.
- **Balances:** shows per-person drove / rode / earned / owed / paid / received / net, and a
  who-owes-whom list **netted per pair** (you ↔ Apurva is always a single number).
- **Record payment:** on a balance, tap *Record payment* — it pre-fills the full amount; type a
  smaller amount for a partial payment. Remaining updates immediately; $0 shows as *Settled*.
- **Everything is custom:** rename/add/remove people, change who can drive, change the rate, and
  change the usual office days in **People & settings**. Any date can be logged, usual day or not.

## Trying it without deploying (local fallback)

Open `public/index.html` directly in a browser (or run `python3 -m http.server -d public 8000`
and visit `http://localhost:8000`). With no `/api` behind it, the app automatically falls back to
**localStorage on that device only** and the badge in the header reads “Local only — not shared.”
That's deliberately separate from shared mode — it's just for a quick look/smoke test, and nothing
entered there carries over to the deployed version.

Optional full local run (real API + a local D1) if you want it:

```bash
npx wrangler d1 execute carpool-tracker --local --file=./schema.sql
npx wrangler pages dev
```

## Cost

Free. Pages' free plan hosts the site + Functions, and D1's free tier is far more than a
5-person carpool will ever use. No other service, server, or paid account is involved.

## Troubleshooting

- **“D1 database is not bound”** — step 5 wasn't done (or no redeploy after it). Variable name must be `DB`.
- **App badge says “Local only”** on the deployed link — `/api` isn't reachable: check the binding (step 5) and that `functions/` was included in the deployment.
- **“Missing or wrong group code”** — the device's code doesn't match `GROUP_CODE`. Use *Set / change group code* in People & settings, or clear it if you removed the variable.
- **Can't remove a person** — they have rides/payments in history, by design (keeps the audit trail honest). Rename them, or delete their rides/payments first.

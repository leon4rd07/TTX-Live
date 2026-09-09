# Deploying TTX Live

## Why not Netlify or Vercel

The app holds WebSocket connections open. Their functions are serverless and
die between requests, so neither can host this. Railway, Render and Fly.io all
can. This guide uses Railway.

---

## 1. GitHub

Create a private repo and upload the contents of the `ttx-app` folder.

Open the folder and select what's inside — `package.json`, `server.js`,
`index.html`, `vite.config.js`, `README.md`, `DEPLOY.md`, and the `src` folder.
Don't drag the `ttx-app` folder itself.

If you do drag the folder and end up with everything one level deep, don't
re-upload. Set Root Directory in Railway instead (step 2).

Skip `node_modules` and `dist`. Railway builds those.

---

## 2. Railway

1. railway.com, log in with GitHub
2. **New Project** → **Deploy from GitHub repo** → pick the repo
3. The first build fails if your files sit inside a subfolder. The log says so:
   `The app contents that Railway analyzed contains: ./ └── ttx-app/`
4. Click the service box on the canvas, then the **Settings** tab in the panel
   that opens — not the gear in the sidebar, and not the project settings page.
   Railway has three things called Settings and only this one is the service.
5. Under **Source**, click **Add Root Directory**, enter `ttx-app`, save
6. It redeploys. Watch for `vite build`, then `TTX server on :3000`

Leave `PORT` alone. Railway sets it and the server reads it.

---

## 3. Get a URL

A successful build still shows **Unexposed service**. There's no address until
you ask for one.

**Settings → Networking → Generate Domain.** Enter port `3000`.

You get `something.up.railway.app`. Open it — landing screen with "Run an
exercise" and "Join an exercise".

---

## 4. Volume

Skip this and a restart mid-exercise loses every answer submitted so far.

1. **Settings → Volumes → Add Volume**, mount path `/data`, 1 GB
2. **Variables → New Variable**, `SNAPSHOT_PATH` = `/data/rooms.json`

---

## 5. Test on the network you'll actually use

Home WiFi proves nothing. Corporate networks are where this breaks, in two
ways: the domain is blocked outright and the page won't load, or the proxy
strips the WebSocket upgrade and the page loads while nothing syncs.

The header shows **Reconnecting** when the socket is blocked. That's how you
tell the two apart.

Test from the actual room, on the actual WiFi, at least a week out.

| Check | Expected |
|---|---|
| Laptop, office WiFi | Page loads, header stays quiet |
| Phone, office WiFi | Same |
| Phone, mobile data | Same |
| Join from phone | Appears in the lobby within a second or two |
| Open, answer, reveal | Answer shows on the facilitator screen |
| Refresh either side | Resumes, nothing lost |

If the office network blocks it, in order of effort: ask IT to allowlist the
hostname; try a custom domain, which sometimes clears category-based blocks;
or host the same code on an internal VM.

---

## Scale

Tested with 400 concurrent participants answering in the same second.

| | Result |
|---|---|
| 400 joins | 3.1s |
| 400 answers submitted at once | settled in 4s |
| Data to the facilitator | 0.05 MB |
| Data to each participant | 0.8 KB |

Answers go to the facilitator only, never fanned out to other participants.
Roster updates are coalesced to one push every 1.5s and disk snapshots are
debounced to every 8s, so a burst of submissions doesn't turn into a burst of
serialisation.

At 400 the facilitator's reveal view collapses long answer lists: it shows the
count, the first five, an expand control, and a keyword filter. Reading 80
answers aloud isn't the plan — scan, filter, pick two or three to discuss.

---

## Before the first real exercise

**There's no authentication.** Anyone with the URL and a four-character code
joins and reads the scenario. A script guesses a four-character code in about a
second. Fine for a dry run on a URL nobody has; not fine once injects name real
systems.

**Warm it up** ten minutes early.

**Send the link the day before** so blocked corporate phones surface in advance.

**Print the injects** as a fallback.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails, only sees a folder | Root Directory → `ttx-app` |
| Build fails, `vite: not found` | Variables → `NPM_CONFIG_PRODUCTION=false` |
| Build green, no URL | Networking → Generate Domain, port 3000 |
| "Application failed to respond" | Deployments → View Logs |
| Page loads, header says Reconnecting | WebSocket blocked. Confirm `https`. Try mobile data to isolate |
| "GitHub Repo not found" | Usually stale after a failed build. If it persists: GitHub → Settings → Applications → Railway → Configure → grant access to the repo |
| Room code not found | Codes exclude I, O, 0, 1. Or the service restarted without a volume |
| Roster empty after redeploy | Rooms are in memory. Don't redeploy mid-exercise |
| Every question lands on one Peran | Header must read Peran, Role, Unit or Business Unit |
| Everything becomes one inject | Header row must be row 1. Delete title rows above it |

---

## Cost

One service plus a 1 GB volume runs about $3–5 of usage a month, inside the
Hobby $5 minimum. Check the Usage tab in month one rather than trusting that.

# AI Polish Worker

A small Cloudflare Worker that proxies "polish this text" requests from the
app to Claude's API. It exists only so the Anthropic API key never has to
ship to the browser — the Worker holds it as a server-side secret.

## One-time setup

1. **Install Wrangler** (Cloudflare's CLI), if you don't have it:
   ```
   npm install -g wrangler
   wrangler login
   ```
   This opens a browser to connect Wrangler to your Cloudflare account (free tier is enough).

2. **Create a KV namespace** (used for the per-IP daily rate limit):
   ```
   cd worker
   wrangler kv namespace create RATE_LIMIT_KV
   ```
   This prints an `id`. Copy it into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

3. **Set your Anthropic API key as a secret** (never written to a file in this repo):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste your key when prompted. Get one from https://console.anthropic.com/settings/keys if you don't have one.

4. **Deploy:**
   ```
   wrangler deploy
   ```
   This prints your Worker's URL — something like
   `https://teacher-connect-ai-polish.<your-subdomain>.workers.dev`.

5. **Add that URL to the app's env config.** In the project root (not this
   `worker/` folder), add to `.env`:
   ```
   VITE_POLISH_WORKER_URL=https://teacher-connect-ai-polish.<your-subdomain>.workers.dev
   ```
   And add the same value as a GitHub Actions secret so the deployed site
   picks it up too:
   ```
   gh secret set VITE_POLISH_WORKER_URL --body "https://teacher-connect-ai-polish.<your-subdomain>.workers.dev"
   ```
   (then add `VITE_POLISH_WORKER_URL: ${{ secrets.VITE_POLISH_WORKER_URL }}`
   to the build step's `env:` in `.github/workflows/deploy.yml`)

## What it does

- Accepts `POST { "text": "..." }`, returns `{ "polished": "..." }`
- Rejects anything over 8000 characters
- Caps each IP address to 30 requests/day (stored in the KV namespace) —
  worth tuning `DAILY_LIMIT_PER_IP` in `index.js` if that's too strict or
  too loose for your usage
- Only accepts requests from `https://sramu-teacher.github.io` (CORS) —
  update `ALLOWED_ORIGIN` in `index.js` if the site ever moves domains

## Cost

Claude Opus 5 at `effort: "low"` on a short paragraph is a few cents per
1,000 polishes at most. Cloudflare Workers' free tier covers 100,000
requests/day, so the Cloudflare side costs nothing at this scale.

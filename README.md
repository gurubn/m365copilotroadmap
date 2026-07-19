# Copilot Roadmap — Signal Board

A free, self-updating web app that shows the **Microsoft 365 Copilot** roadmap in an
interactive board, plus the latest "What's New" posts from Microsoft Tech Community.
No server, no database, no cost.

## How it works

```
GitHub Actions (weekly cron)  ->  scripts/fetch.mjs  ->  data/roadmap.json  ->  index.html (GitHub Pages)
```

1. **`scripts/fetch.mjs`** pulls the public M365 roadmap JSON
   (`https://www.microsoft.com/releasecommunications/api/v1/m365`), keeps only
   Copilot items, and pulls recent Tech Community posts. It writes `data/roadmap.json`.
   Fetching happens server-side in the Action, which avoids browser CORS blocks.
2. **`.github/workflows/update.yml`** runs that script every Monday and commits the
   refreshed JSON back to the repo.
3. **`index.html`** is a static page that reads `data/roadmap.json` and renders the
   filterable board. GitHub Pages serves it for free.

## Deploy in ~3 minutes

1. Create a new **public** GitHub repo and upload these files (keep the folder layout).
2. Go to **Settings -> Pages** -> Source: *Deploy from a branch* -> Branch: `main`, folder `/ (root)` -> Save.
   Your site appears at `https://<you>.github.io/<repo>/`.
3. Go to the **Actions** tab, enable workflows, and click **Run workflow** on
   "Refresh Copilot roadmap" once to pull live data immediately.
4. After that it refreshes itself every Monday. Change the `cron` line in the workflow
   to pick a different day/time (it's in UTC).

## Local preview

```bash
node scripts/fetch.mjs      # pulls live data into data/roadmap.json (Node 20+)
python3 -m http.server 8000 # then open http://localhost:8000
```

The repo ships with a small sample `data/roadmap.json` so the page works before the
first fetch.

## Customizing

- **Change the sources filter:** edit `isCopilot()` in `scripts/fetch.mjs` (e.g. filter
  on a specific product tag like `"Microsoft 365 Copilot"` instead of any "copilot" match).
- **Tech Community feed:** the RSS URL is the `TECHCOMMUNITY_RSS` constant at the top of
  the script. If the feed path changes, update that one line — the build degrades to an
  empty news list rather than failing.
- **Look and feel:** all styling is in the `<style>` block of `index.html`.

## Free-hosting alternatives

The exact same files also deploy to **Cloudflare Pages** or **Netlify** free tiers.
On those you'd move the weekly fetch to their scheduled-function feature instead of
GitHub Actions.

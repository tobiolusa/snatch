# Snatch

A fast, installable PWA for downloading TikTok videos **without the watermark**.
Single page, works on mobile and desktop, no build step — just static files.

## Features

**Core**
- Paste a TikTok link, fetch the clean (no-watermark) video via the public [tikwm.com](https://tikwm.com) API
- Video preview + one-tap Save
- Persistent lifetime download counter
- Recent-downloads history with a "Again" re-download button

**Added**
- **Clipboard detection** — on open, offers to paste a TikTok link it finds on the clipboard
- **Format choice** — video only or audio only (MP3)
- **Quality choice** — Standard or HD, HD auto-disabled when the API doesn't offer it
- **Batch mode** — paste many links (one per line); they queue and process one by one
- **Retry logic** — visible Retry button on any failed or timed-out fetch; per-item retry in the queue
- **Duplicate detection** — warns if a link is already in history instead of silently counting it again
- **Daily & weekly stats** — today / this week / last week / lifetime, a 14-day bar chart, and a by-day breakdown
- **Auto-save to device** — uses the File System Access API where supported, falls back to a normal download link
- **Dark / light theme** toggle, saved as a preference (dark by default)
- **Settings screen** — reset counter, clear history, default format, duplicate-warning toggle
- **Share target** — once installed on Android, share a TikTok straight into Snatch
- **Bulk export** — dump the whole history to a plain-text file
- **Watermark toggle** — grab the original TikTok file instead of the clean one, for when the clean result fails

## Run locally

Any static server over HTTPS or `localhost` (service workers need a secure context):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

Upload the folder to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages).
The share target and install prompt need the app served from the site root (`scope: "/"`).

## Notes

- All data (counter, history, stats, settings) is stored in `localStorage` on the device only.
- Watermark removal depends on the third-party tikwm.com API and its rate limits (~1 request/sec, which is why batch mode paces itself).
- Cross-origin media that can't be fetched as a blob is opened in a new tab so the browser can save it.

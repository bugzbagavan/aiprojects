# BugScribe (Chrome MV3 extension)

BugScribe records the active browser tab plus your microphone, mixes
the audio, and saves the result as **MP4 (H.264 + AAC)** so it plays
natively in Windows Media Player. All processing is client-side — no
server required. On Chrome 126+ it records MP4 directly and skips
transcoding entirely; on older Chrome it falls back to WebM and
re-encodes via `ffmpeg.wasm`. testing

## Features

- **Floating in-page widget** — a small dot in the bottom-right of
  every page expands into a Start / Stop / Save panel. Multiple
  recordings, back-to-back, no popup juggling.
- **Toolbar popup** — same controls if you prefer the action button.
- One-click recording of the active tab (video + tab audio).
- Simultaneous microphone capture for narration; tab audio + mic
  mixed into one track.
- **Fast path** (Chrome 126+): `MediaRecorder` writes MP4 directly,
  Stop → Save dialog in milliseconds.
- **Fallback** (older Chrome): WebM → MP4 via `ffmpeg.wasm` with a
  live progress percentage.
- Output filename: `recording_YYYY-MM-DD_HH-MM-SS.mp4`
- Auto-prompts the standard "Save As" dialog when recording stops.
- Manifest V3, Chrome 116+.

## Folder layout

```
tab-recorder-extension/
├── package.json          # npm deps + build script
├── webpack.config.js     # bundles src/ and copies ffmpeg-core
├── public/
│   ├── manifest.json     # MV3 manifest
│   ├── popup.html        # toolbar popup UI
│   └── offscreen.html    # hidden host page for MediaRecorder + ffmpeg
├── src/
│   ├── popup.js          # UI logic, timer, requests tabCapture stream id
│   ├── background.js     # service worker, owns offscreen doc + state
│   └── offscreen.js      # getUserMedia, MediaRecorder, ffmpeg, download
└── dist/                 # build output — load THIS in Chrome
```

## Build

Requires Node.js 18+.

```bash
cd tab-recorder-extension
npm install
npm run build
```

That produces a self-contained `dist/` folder containing:

- `manifest.json`, `popup.html`, `offscreen.html`
- `popup.js`, `background.js`, `offscreen.js` (webpack bundles)
- `ffmpeg-core/ffmpeg-core.js` and `ffmpeg-core/ffmpeg-core.wasm`
  (copied from `@ffmpeg/core` so they load via `chrome-extension://`)

For iterative development:

```bash
npm run dev   # webpack --watch
```

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `tab-recorder-extension/dist` folder.
5. Pin the extension to the toolbar.

## Use it

There are two equivalent UIs:

**A. In-page floating widget** (recommended for back-to-back recordings)
1. Open any regular `http(s)` page.
2. Look for the round BugScribe button in the bottom-right corner.
3. Click it → **Start Recording**.
4. Narrate while you reproduce the bug. Timer ticks live.
5. Click **Stop Recording**. On Chrome 126+ the Save As dialog opens
   immediately; on older Chrome you'll see a "Processing … xx%"
   readout while ffmpeg encodes.
6. Click **Start Recording** again for the next clip — no reprompts.

**B. Toolbar popup** (same controls, different surface)
- Click the BugScribe icon in the Chrome toolbar.

**First-time microphone setup**: when you first click Start, a small
permission window opens. Click *Grant Microphone Access* → *Allow*
in Chrome's prompt → the window auto-closes. After that, every
subsequent recording uses the cached mic without re-prompting.

## How it works

- The popup acquires a tab-capture stream id with
  `chrome.tabCapture.getMediaStreamId({ targetTabId })`. Doing this
  from the popup preserves the user-activation gesture.
- The id is forwarded to the **offscreen document** (created via
  `chrome.offscreen.createDocument`). MV3 service workers can't use
  `MediaRecorder`/`AudioContext`, so the offscreen page does the work.
- In the offscreen doc:
  - `getUserMedia` is called twice — once with `chromeMediaSource:'tab'`
    (the captured tab) and once with `audio:true` (the mic).
  - Tab audio + mic are mixed through a `Web Audio` graph; tab audio
    is also routed back to the speakers so the page isn't silenced.
  - `MediaRecorder` writes WebM (VP9/Opus) chunks.
  - On stop, the chunks are concatenated, fed into `ffmpeg.wasm`, and
    re-encoded with `-c:v libx264 -preset ultrafast -c:a aac
    -movflags +faststart`.
  - `chrome.downloads.download({ saveAs: true })` triggers the save
    dialog with the timestamped filename.

## Troubleshooting

- **"Cannot record internal browser pages"** — `chrome://` and the
  Web Store cannot be captured. Switch to a normal site.
- **Mic prompt never appears** — Chrome remembers a previous denial.
  Visit `chrome://settings/content/microphone` and remove the
  extension from the blocked list, or reset permissions for it under
  `chrome://extensions` → details → site settings.
- **Encoding takes a long time for long recordings** — the H.264
  encode runs in WebAssembly (single-threaded). Roughly real-time on
  a modern laptop at `ultrafast`. Keep recordings short for fastest
  turnaround, or tweak `-preset` / bitrate in `src/offscreen.js`.
- **Worker / wasm CSP errors** — make sure you loaded the **`dist/`**
  folder in Chrome (not the project root); the manifest there sets
  `'wasm-unsafe-eval'` and the bundled worker URL is same-origin.

## Tweakables

In `src/offscreen.js`:

- `videoBitsPerSecond: 4_000_000` on the `MediaRecorder` controls the
  source recording quality.
- The `ffmpeg.exec([...])` array is the full re-encode command — swap
  `ultrafast` for `veryfast`/`faster` for smaller files at the cost
  of CPU time, or change `-b:a` for audio bitrate.

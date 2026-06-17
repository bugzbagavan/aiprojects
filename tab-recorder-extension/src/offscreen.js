// Offscreen document: owns getUserMedia + MediaRecorder + ffmpeg.wasm.
// Runs in a normal DOM context so it has access to AudioContext / MediaRecorder
// (the MV3 service worker can't use those APIs).

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { uploadAttachment, linkAttachment } from './azureDevOps.js';

let mediaRecorder = null;
let recordedChunks = [];
let recorderContainer = 'webm'; // 'mp4' (no transcode) or 'webm' (needs ffmpeg)
let combinedStream = null;
let tabStream = null;
// Persistent across recordings: acquired once, reused for every subsequent
// MediaRecorder session so we never trigger a second mic permission prompt
// (which would silently dismiss in this hidden offscreen context).
let persistentMicStream = null;
let audioCtx = null;
let lastMp4Blob = null;
let lastFilename = null;

async function getMicStream() {
  const live = persistentMicStream &&
               persistentMicStream.getAudioTracks().some(t => t.readyState === 'live');
  if (live) return persistentMicStream;
  // First call only — relies on permission already being granted to the
  // extension origin (see permissions.html flow).
  persistentMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return persistentMicStream;
}

let ffmpeg = null;
async function getFfmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => console.log('[ffmpeg]', message));
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL('ffmpeg-core/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('ffmpeg-core/ffmpeg-core.wasm')
  });
  return ffmpeg;
}

// Probe for the fastest pipeline first: MP4 in MediaRecorder (Chrome 126+)
// produces an H.264/AAC file natively, so we skip the ffmpeg.wasm re-encode
// entirely. WebM is the slow fallback that still needs a transcode.
function pickMimeType() {
  const candidates = [
    { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', container: 'mp4' },
    { mime: 'video/mp4;codecs=avc1,mp4a',                container: 'mp4' },
    { mime: 'video/mp4',                                  container: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus',                 container: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus',                 container: 'webm' },
    { mime: 'video/webm',                                 container: 'webm' }
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: 'video/webm', container: 'webm' };
}

function pad(n) { return String(n).padStart(2, '0'); }

function generateFilename() {
  const d = new Date();
  return `recording_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
         `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.mp4`;
}

async function startRecording(streamId) {
  if (mediaRecorder) throw new Error('Already recording');

  // 1. Tab capture (audio+video). chromeMediaSource:'tab' is required by tabCapture.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
  });

  // 2. Microphone — reuse the persistent stream when possible so Chrome never
  // re-prompts. Only the very first acquisition can trigger a prompt, and
  // that prompt won't display in this hidden context.
  let micStream;
  try {
    micStream = await getMicStream();
  } catch (err) {
    tabStream.getTracks().forEach(t => t.stop());
    try { await chrome.storage?.local?.set({ micPermissionGranted: false }); } catch {}
    throw new Error('Microphone unavailable (' + err.message + '). Re-grant access via the permissions tab.');
  }

  // 3. Mix tab audio + mic into a single audio track.
  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();

  const tabAudioTracks = tabStream.getAudioTracks();
  if (tabAudioTracks.length) {
    const tabAudioSource = audioCtx.createMediaStreamSource(new MediaStream(tabAudioTracks));
    tabAudioSource.connect(dest);
    // Re-route tab audio to the user's speakers so the page isn't muted while recording.
    tabAudioSource.connect(audioCtx.destination);
  }
  const micAudioSource = audioCtx.createMediaStreamSource(micStream);
  micAudioSource.connect(dest);

  combinedStream = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  // If the user closes/navigates the captured tab, the video track ends.
  combinedStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch {}
    }
  });

  recordedChunks = [];
  const picked = pickMimeType();
  recorderContainer = picked.container;
  console.log('[bug-recorder] MediaRecorder mime:', picked.mime,
              '— pipeline:', picked.container === 'mp4' ? 'fast (no transcode)' : 'slow (ffmpeg WebM→MP4)');
  mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: picked.mime,
    videoBitsPerSecond: 4_000_000
  });
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start(1000); // collect chunks every 1s
}

function stopMediaTracks() {
  // Stop only the per-recording streams. persistentMicStream stays live so
  // the next recording can reuse it without a new getUserMedia call.
  try { combinedStream && combinedStream.getTracks().forEach(t => t.stop()); } catch {}
  try { tabStream && tabStream.getTracks().forEach(t => t.stop()); } catch {}
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
  }
  combinedStream = null;
  tabStream = null;
  audioCtx = null;
}

function reportProgress(patch) {
  chrome.runtime.sendMessage({ target: 'background', type: 'state-update', patch })
        .catch(() => {});
}

async function stopRecordingAndProcess() {
  if (!mediaRecorder) throw new Error('Not recording');

  // Wait for the final dataavailable event before assembling the blob.
  const recorder = mediaRecorder;
  const finished = new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
  });
  recorder.stop();
  await finished;
  mediaRecorder = null;
  stopMediaTracks();

  if (recorderContainer === 'mp4') {
    // Fast path — the recorder produced an MP4 (H.264/AAC) directly.
    // No transcode needed; just stitch the chunks and download.
    reportProgress({ processingProgress: 100, processingStage: 'finalizing' });
    lastMp4Blob = new Blob(recordedChunks, { type: 'video/mp4' });
    recordedChunks = [];
  } else {
    // Slow path — WebM (VP9/Opus) needs a re-encode for Windows Media Player.
    reportProgress({ processingProgress: 0, processingStage: 'encoding' });
    const webmBlob = new Blob(recordedChunks, { type: 'video/webm' });
    recordedChunks = [];

    const ff = await getFfmpeg();
    const onProgress = ({ progress }) => {
      const pct = Math.max(0, Math.min(99, Math.round((progress || 0) * 100)));
      reportProgress({ processingProgress: pct, processingStage: 'encoding' });
    };
    ff.on('progress', onProgress);
    try {
      await ff.writeFile('input.webm', await fetchFile(webmBlob));
      await ff.exec([
        '-i', 'input.webm',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        'output.mp4'
      ]);
      const data = await ff.readFile('output.mp4');
      try { await ff.deleteFile('input.webm'); } catch {}
      try { await ff.deleteFile('output.mp4'); } catch {}
      lastMp4Blob = new Blob([data.buffer], { type: 'video/mp4' });
    } finally {
      try { ff.off?.('progress', onProgress); } catch {}
    }
    reportProgress({ processingProgress: 100, processingStage: 'finalizing' });
  }

  lastFilename = generateFilename();
  // NOTE: We deliberately do NOT trigger the download here. After stop the
  // MP4 sits in memory and the UI shows a "Save Video" prompt; the user
  // clicks Save, which routes through the background as a `redownload`
  // action and actually writes the file via chrome.downloads. This gives
  // the user a clear "save first, then create bug" two-step flow.
  return { ok: true, filename: lastFilename };
}

async function triggerDownload(blob, filename) {
  // chrome.downloads is not available in offscreen documents, so we hand the
  // blob URL off to the service worker which has the API. The blob URL is
  // resolvable across the extension origin while this offscreen doc is alive.
  const url = URL.createObjectURL(blob);
  try {
    const resp = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'download-url',
      url,
      filename
    });
    if (!resp || !resp.ok) throw new Error(resp?.error || 'Download failed');
  } finally {
    // Revoke after a short delay so the download has time to read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    try {
      if (msg.action === 'start') {
        await startRecording(msg.streamId);
        sendResponse({ ok: true });
      } else if (msg.action === 'stop') {
        const r = await stopRecordingAndProcess();
        sendResponse(r);
      } else if (msg.action === 'redownload') {
        if (!lastMp4Blob || !lastFilename) {
          sendResponse({ ok: false, error: 'No recording available to save' });
          return;
        }
        await triggerDownload(lastMp4Blob, lastFilename);
        sendResponse({ ok: true, filename: lastFilename });
      } else if (msg.action === 'azure-attach') {
        // Upload the in-memory MP4 to Azure and attach it to the given bug.
        if (!lastMp4Blob || !lastFilename) {
          sendResponse({ ok: false, error: 'No recording available to attach' });
          return;
        }
        const filename = msg.filename || lastFilename;
        const azure = msg.azure || {};
        if (!azure.pat || !azure.org || !azure.project) {
          sendResponse({ ok: false, error: 'Azure DevOps credentials missing in request' });
          return;
        }
        if (!msg.workItemId) {
          sendResponse({ ok: false, error: 'Missing workItemId' });
          return;
        }
        const uploaded = await uploadAttachment({
          ...azure, blob: lastMp4Blob, filename
        });
        await linkAttachment({
          ...azure,
          workItemId: msg.workItemId,
          attachmentUrl: uploaded.url,
          filename
        });
        sendResponse({ ok: true, attachmentId: uploaded.id, attachmentUrl: uploaded.url });
      } else {
        sendResponse({ ok: false, error: 'Unknown action: ' + msg.action });
      }
    } catch (err) {
      console.error('[offscreen]', err);
      stopMediaTracks();
      mediaRecorder = null;
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async sendResponse
});

// Service worker: coordinates popup <-> offscreen document, owns recording state.

const OFFSCREEN_URL = 'offscreen.html';
//testing changes in git
async function hasOffscreen() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  // Fallback for older Chrome: list contexts.
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS'],
    justification: 'Capture tab + microphone via MediaRecorder and remux to MP4 with ffmpeg.wasm.'
  });
}

async function setState(patch) {
  const cur = await chrome.storage.session.get(null);
  await chrome.storage.session.set({ ...cur, ...patch });
  // Best-effort notify popup. If popup is closed the call rejects — swallow it.
  chrome.runtime.sendMessage({ target: 'popup', type: 'state-changed' }).catch(() => {});
}

async function resetState() {
  await chrome.storage.session.set({
    isRecording: false,
    processing: false,
    startTime: null,
    lastFilename: null,
    lastError: null,
    // `savedToDisk` gates the "Create Bug in Azure DevOps" button. Stop now
    // only produces an in-memory MP4 and a `lastFilename` — the file does
    // not hit disk until the user clicks Save, which flips this flag.
    savedToDisk: false
  });
}

// Allow content scripts to read chrome.storage.session so the in-page widget
// can render its current state directly from storage.
async function openSessionToContentScripts() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (e) {
    console.warn('[bg] setAccessLevel failed:', e.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await openSessionToContentScripts();
  await resetState();
});
chrome.runtime.onStartup.addListener(async () => {
  await openSessionToContentScripts();
  await resetState();
});

async function ensureMicGranted(sender) {
  let granted = false;
  try {
    const got = await chrome.storage.local.get('micPermissionGranted');
    granted = !!got.micPermissionGranted;
  } catch {}
  if (granted) return true;

  // Preferred path: ask the active tab's content script to embed the
  // permissions page as an iframe. That surfaces Chrome's standard mic
  // prompt next to the page's URL bar (the "site information" UI), keeping
  // the experience inline with the page instead of opening a new window.
  try {
    let targetTabId = sender?.tab?.id;
    if (!targetTabId) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = tab?.id;
    }
    if (targetTabId) {
      const ack = await chrome.tabs
        .sendMessage(targetTabId, { type: 'request-mic-permission' })
        .catch(() => null);
      // Content script ack means the iframe is showing — the user will
      // grant via the URL-bar prompt, then click Start again.
      if (ack && ack.ok) return false;
    }
  } catch (err) {
    console.warn('[bg] inline mic permission unavailable:', err.message);
  }

  // Fallback: chrome:// pages and other restricted origins don't have the
  // content script, so fall back to the standalone popup window.
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('permissions.html'),
      type: 'popup',
      width: 520,
      height: 360
    });
  } catch {}
  return false;
}

async function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;

  (async () => {
    try {
      if (msg.type === 'start') {
        // Single source of truth for the mic-permission gate so both the
        // popup and the in-page content-script widget go through it.
        if (!(await ensureMicGranted(sender))) {
          sendResponse({
            ok: false,
            error: 'Grant microphone access in the prompt that just appeared in the address bar, then click Start again.'
          });
          return;
        }

        // Resolve the tab whose contents we're recording. The popup passes
        // streamId or targetTabId explicitly; the content-script widget
        // sends nothing and we use sender.tab.
        let streamId = msg.streamId;
        if (!streamId) {
          let targetTabId = msg.targetTabId || sender.tab?.id;
          if (!targetTabId) {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            targetTabId = tab?.id;
          }
          if (!targetTabId) {
            sendResponse({ ok: false, error: 'No target tab' });
            return;
          }
          try {
            streamId = await getStreamIdForTab(targetTabId);
          } catch (e) {
            sendResponse({ ok: false, error: 'Tab capture unavailable: ' + e.message });
            return;
          }
        }

        await ensureOffscreen();
        await setState({
          isRecording: true,
          processing: false,
          processingProgress: null,
          processingStage: null,
          startTime: Date.now(),
          lastFilename: null,
          lastError: null,
          savedToDisk: false
        });
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'start',
          streamId
        });
        if (!resp || !resp.ok) {
          await setState({ isRecording: false, lastError: resp?.error || 'Failed to start' });
          sendResponse({ ok: false, error: resp?.error || 'Failed to start' });
          return;
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'stop') {
        await setState({ isRecording: false, processing: true });
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'stop'
        });
        if (resp && resp.ok) {
          await setState({
            processing: false,
            processingProgress: null,
            processingStage: null,
            lastFilename: resp.filename,
            lastError: null,
            // Processing done but the file is still only in memory — the
            // user must click Save before "Create Bug" becomes available.
            savedToDisk: false
          });
        } else {
          await setState({
            processing: false,
            processingProgress: null,
            processingStage: null,
            lastError: resp?.error || 'Processing failed'
          });
        }
        sendResponse(resp || { ok: false, error: 'No response from offscreen' });
      } else if (msg.type === 'save') {
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'redownload'
        });
        // Mark saved only on a successful download — preserves the "Save"
        // CTA if the user dismissed the OS save dialog.
        if (resp && resp.ok) {
          await setState({ savedToDisk: true, lastError: null });
        }
        sendResponse(resp || { ok: false, error: 'No prior recording' });
      } else if (msg.type === 'state-update') {
        // Offscreen pushes informational state (e.g., processing progress).
        await setState(msg.patch || {});
        sendResponse({ ok: true });
      } else if (msg.type === 'azure-attach') {
        // Content script asks us to attach the last recording to a work item.
        // The MP4 blob lives in the offscreen document, so we forward the
        // upload+link there. No offscreen → no recording → fail fast.
        if (!(await hasOffscreen())) {
          sendResponse({ ok: false, error: 'No recording available (offscreen document is gone). Record again before attaching.' });
          return;
        }
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'azure-attach',
          workItemId: msg.workItemId,
          filename: msg.filename,
          azure: msg.azure
        });
        sendResponse(resp || { ok: false, error: 'No response from offscreen' });
      } else if (msg.type === 'download-url') {
        // chrome.downloads isn't available in offscreen documents, so the
        // service worker performs the download on its behalf.
        if (!chrome.downloads || !chrome.downloads.download) {
          sendResponse({ ok: false, error: 'chrome.downloads unavailable — reload the extension after granting the downloads permission.' });
          return;
        }
        const id = await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          saveAs: true
        });
        sendResponse({ ok: true, downloadId: id });
      }
    } catch (err) {
      console.error('[bg]', err);
      await setState({ isRecording: false, processing: false, lastError: err.message });
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // async sendResponse
});

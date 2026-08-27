// Popup UI: drives Start/Stop/Save and shows the live timer/status.

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const saveBtn = document.getElementById('save');
const bugBtn = document.getElementById('createBug');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');

// Mirrors the gate in content.js: Create Bug only lights up when the build
// has Azure credentials AND the user has saved the recording.
const AZURE_ENABLED = !!(
  (process.env.AZURE_PAT || '').trim() &&
  (process.env.AZURE_ORG_URL || '').trim() &&
  (process.env.AZURE_PROJECT || '').trim()
);

// chrome.storage may not be available if the extension was loaded before the
// `storage` permission was granted. Wrap access so a missing API surfaces as
// a clear, actionable error and falls back to defaults instead of crashing.
async function safeStorageGet(area, keys) {
  try {
    if (!chrome?.storage?.[area]) throw new Error('chrome.storage.' + area + ' unavailable');
    return await chrome.storage[area].get(keys);
  } catch (err) {
    console.warn('[popup] storage.' + area + '.get failed:', err.message);
    return {};
    console.log("something - updated");
  }
}

let timerHandle = null;

function fmtTime(elapsedMs) {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function startTimer(startTime) {
  stopTimer();
  const tick = () => { timerEl.textContent = fmtTime(Date.now() - startTime); };
  tick();
  timerHandle = setInterval(tick, 500);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

async function refreshState() {
  const s = await safeStorageGet('session', null);
  if (s.isRecording) {
    statusEl.innerHTML = '<span class="recording-dot"></span>Recording…';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    saveBtn.disabled = true;
    bugBtn.classList.add('hidden');
    if (s.startTime) startTimer(s.startTime);
  } else if (s.processing) {
    const pct = typeof s.processingProgress === 'number' ? s.processingProgress : null;
    const stage = s.processingStage === 'finalizing' ? 'finalizing' : 'encoding MP4';
    statusEl.textContent = pct === null
      ? 'Processing… (' + stage + ')'
      : 'Processing… ' + pct + '% (' + stage + ')';
    startBtn.disabled = true;
    stopBtn.disabled = true;
    saveBtn.disabled = true;
    bugBtn.classList.add('hidden');
    stopTimer();
  } else {
    const readyToSave = !!s.lastFilename && !s.savedToDisk;
    const saved       = !!s.lastFilename &&  s.savedToDisk;
    if (s.lastError) {
      statusEl.textContent = 'Error: ' + s.lastError;
    } else if (readyToSave) {
      statusEl.textContent = 'Recording ready — click Save to download.';
    } else if (saved) {
      statusEl.textContent = 'Saved: ' + s.lastFilename;
    } else {
      statusEl.textContent = 'Idle';
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    saveBtn.disabled = !s.lastFilename;
    // Create Bug only after explicit Save, and only if the build has Azure
    // credentials baked in by webpack.DefinePlugin.
    if (saved && AZURE_ENABLED) {
      bugBtn.classList.remove('hidden');
    } else {
      bugBtn.classList.add('hidden');
    }
    stopTimer();
    timerEl.textContent = '00:00';
  }
}

async function ensureMicPermission() {
  // The popup auto-closes when the mic prompt appears, so we can't request
  // it from here. Instead, route the user to a dedicated tab the first
  // time. Once granted, Chrome remembers it for the extension origin and
  // the offscreen doc can use the mic without prompting.
  const { micPermissionGranted } = await safeStorageGet('local', 'micPermissionGranted');
  if (micPermissionGranted) return true;
  // Open a small standalone window (not a tab) so the browser permission
  // prompt has a stable, focused context to display in. The window
  // auto-closes itself once the user clicks Allow.
  await chrome.windows.create({
    url: chrome.runtime.getURL('permissions.html'),
    type: 'popup',
    width: 520,
    height: 360
  });
  throw new Error('Grant microphone access in the small window that opened, then click Start again.');
}

startBtn.addEventListener('click', async () => {
  try {
    statusEl.textContent = 'Checking permissions…';
    await ensureMicPermission();

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('No active tab found.');
    if (/^chrome:|^chrome-extension:|^edge:|^about:/.test(tab.url || '')) {
      throw new Error('Cannot record internal browser pages. Switch to a regular http(s) tab.');
    }

    // Acquire a tab-capture stream id while we still have user activation.
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(id);
      });
    });

    const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'start', streamId });
    if (!resp || !resp.ok) throw new Error(resp?.error || 'Failed to start recording');
    refreshState();
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    console.error(err);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    statusEl.textContent = 'Stopping…';
    stopBtn.disabled = true;
    const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
    if (!resp || !resp.ok) throw new Error(resp?.error || 'Failed to stop');
    refreshState();
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    refreshState();
  }
});

saveBtn.addEventListener('click', async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'save' });
    if (!resp || !resp.ok) throw new Error(resp?.error || 'Save failed');
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
});

bugBtn.addEventListener('click', async () => {
  // The modal lives in the in-page content script's shadow root, so we
  // forward the click to the active tab. The popup closes itself once the
  // modal is open so it doesn't hover in front of the form.
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    if (/^chrome:|^chrome-extension:|^edge:|^about:/.test(tab.url || '')) {
      throw new Error('Open a regular web page first — the bug modal cannot inject into internal browser pages.');
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'open-bug-modal' }).catch(() => null);
    if (!resp || !resp.ok) {
      throw new Error('Could not open the modal on this tab. Reload the page and try again.');
    }
    window.close();
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'popup' && msg.type === 'state-changed') refreshState();
});

refreshState();

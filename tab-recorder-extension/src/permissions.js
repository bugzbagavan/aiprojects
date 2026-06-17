// Page for granting microphone permission. Used in two modes:
//   1. Standalone window — loaded via chrome.windows.create as a fallback
//      when no content script is available (chrome:// pages, etc.).
//   2. Embedded iframe — injected by the content script into the in-page
//      floater. Chrome's mic prompt then anchors to the host page's URL
//      bar / "site information" UI, so the user grants permission inline
//      without a separate window popping up.
// Mode is signalled by the `embed=1` query string and confirmed by
// checking whether we're running inside an iframe.

const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1' && window.parent !== window;

const grantBtn = document.getElementById('grant');
const statusEl = document.getElementById('status');

// Communicate back to the content script's window listener. Using `*` for
// targetOrigin is safe because we only send non-sensitive flags; the
// content script filters by `source: 'bugscribe-permissions'`.
function postToParent(type) {
  if (!EMBED) return;
  try { window.parent.postMessage({ source: 'bugscribe-permissions', type }, '*'); } catch {}
}

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = (kind ? kind + ' ' : '') + 'shown';
}

if (EMBED) {
  // Compact body styling and clearer call-to-action for the iframe case.
  document.body.classList.add('embed');
}

async function checkExisting() {
  // If the user already granted, just confirm and stop.
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'granted') {
      await chrome.storage.local.set({ micPermissionGranted: true });
      setStatus('Microphone access is already granted.', 'ok');
      grantBtn.disabled = true;
      postToParent('mic-granted');
    }
  } catch {
    // permissions.query may not support 'microphone' on all platforms — ignore.
  }
}

grantBtn.addEventListener('click', async () => {
  setStatus('Waiting for browser prompt…', '');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    await chrome.storage.local.set({ micPermissionGranted: true });
    grantBtn.disabled = true;
    if (EMBED) {
      setStatus('Permission granted.', 'ok');
      postToParent('mic-granted');
    } else {
      setStatus('Permission granted. Closing… click the extension icon to start recording.', 'ok');
      setTimeout(() => window.close(), 1200);
    }
  } catch (err) {
    try { await chrome.storage.local.set({ micPermissionGranted: false }); } catch {}
    setStatus('Permission failed: ' + err.message + '. Click the button again to retry.', 'err');
    postToParent('mic-denied');
  }
});

checkExisting();

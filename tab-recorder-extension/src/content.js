// Content script: injects a floating widget on every http(s) page so the
// user can start/stop/save recordings without opening the toolbar popup.
// Lets the user run multiple recordings back-to-back on the same page.
//
// After a recording is saved, a "Create Bug in Azure DevOps" button appears
// inside the panel. Clicking it opens a modal (still in the shadow root) for
// title / assignee / area / iteration / category / priority / severity.
// On submit the form is sent to Azure as a Bug work item, the MP4 is
// uploaded via the Attachments API by the offscreen document (which still
// owns the blob), and the link to the new work item is shown.

import {
  readAzureConfigFromEnv,
  hasAzureConfig,
  listTeamMembers,
  listAreaPaths,
  listIterationPaths,
  listFieldsForType,
  findFieldByDisplayName,
  createWorkItem,
  getWorkItem,
  parentLinkRelation,
  uploadAttachment,
  linkAttachment,
  workItemUrl
} from './azureDevOps.js';

// Per-work-item-type configuration. Keep this small + declarative so adding
// another type (e.g. "Task") is just adding an entry.
const WORK_ITEM_TYPES = ['Bug', 'Suggestion'];

const CATEGORIES_BY_TYPE = {
  'Bug': ['Build', 'Business Logic', 'CURD I/O', 'Database', 'Deploy', 'Performance', 'Security', 'Typo', 'UI', 'UX', 'Validation'],
  'Suggestion': ['Business Logic', 'Database', 'Security', 'UI', 'UX', 'Validation']
};

const CATEGORY_LABEL_BY_TYPE = {
  'Bug': 'Bug Category',
  'Suggestion': 'Category'
};

// Display name of the Azure custom field that stores the category. The
// reference name is discovered at runtime via listFieldsForType.
const CATEGORY_FIELD_DISPLAY_NAME = {
  'Bug': 'Bug Category',
  'Suggestion': 'Category'
};

(function () {
  if (window.__bugRecorderInjected) return;
  window.__bugRecorderInjected = true;

  // Don't inject inside an iframe — only the top frame gets the widget.
  if (window.top !== window) return;

  const AZURE = readAzureConfigFromEnv();
  const AZURE_ENABLED = hasAzureConfig(AZURE);

  // Outer host element — uses Shadow DOM so page CSS can't bleed in.
  const host = document.createElement('div');
  host.setAttribute('data-bug-recorder', 'host');
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'z-index: 2147483647',
    'pointer-events: auto'
  ].join(';');

  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .fab {
        width: 52px; height: 52px; border-radius: 50%;
        background: linear-gradient(135deg, #c92a2a 0%, #862e9c 100%);
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        cursor: grab; border: none;
        box-shadow: 0 4px 14px rgba(0,0,0,.32);
        transition: transform .12s ease, box-shadow .12s ease;
        padding: 0;
        touch-action: none; /* let pointermove drive drag instead of page scroll */
      }
      .fab:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,0,0,.38); }
      .fab.dragging,
      .fab.dragging:hover {
        cursor: grabbing;
        transform: scale(1.05);
        transition: none;
        box-shadow: 0 8px 22px rgba(0,0,0,.45);
      }
      .fab svg { width: 22px; height: 22px; pointer-events: none; }
      .fab.recording { background: #c92a2a; animation: pulse 1.2s infinite; }
      .fab.processing { background: linear-gradient(135deg, #f08c00 0%, #c92a2a 100%); }
      @keyframes pulse {
        0%, 100% { box-shadow: 0 4px 14px rgba(0,0,0,.32), 0 0 0 0 rgba(201,42,42,.55); }
        50%      { box-shadow: 0 4px 14px rgba(0,0,0,.32), 0 0 0 10px rgba(201,42,42,0); }
      }
      .panel {
        position: absolute; right: 0; bottom: 64px;
        width: 260px;
        background: #ffffff; color: #212529;
        border: 1px solid #e9ecef; border-radius: 10px;
        box-shadow: 0 10px 32px rgba(0,0,0,.18);
        overflow: hidden;
        animation: slideIn .15s ease-out;
      }
      .panel.hidden { display: none; }
      @keyframes slideIn {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .ph {
        background: linear-gradient(135deg, #c92a2a 0%, #862e9c 100%);
        color: #fff;
        padding: 12px 14px;
        display: flex; align-items: center; justify-content: space-between;
      }
      .ph .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
      .ph svg.cam { width: 18px; height: 18px; }
      .close {
        background: transparent; border: none; cursor: pointer;
        color: rgba(255,255,255,.85); font-size: 18px; line-height: 1;
        padding: 0 4px; border-radius: 3px;
      }
      .close:hover { background: rgba(255,255,255,.18); color: #fff; }
      .pb { padding: 12px 14px 14px; }
      .timer {
        font-family: ui-monospace, "SF Mono", Consolas, Menlo, monospace;
        font-size: 26px; font-weight: 700;
        letter-spacing: 1px;
        text-align: center; padding: 4px 0;
        color: #212529;
      }
      .status {
        background: #f8f9fa; padding: 7px 10px; border-radius: 5px;
        margin: 4px 0 10px; min-height: 30px; word-break: break-word;
        font-size: 12px; color: #495057;
        display: flex; align-items: center;
        line-height: 1.35;
      }
      .rdot {
        display: inline-block;
        width: 8px; height: 8px; border-radius: 50%;
        background: #c92a2a;
        margin-right: 6px;
        animation: blink 1s infinite;
        flex-shrink: 0;
      }
      @keyframes blink { 50% { opacity: .35; } }
      button.btn {
        display: flex; align-items: center; justify-content: center;
        gap: 8px;
        width: 100%; padding: 8px 10px; margin-top: 5px;
        border-radius: 5px; border: 1px solid #e9ecef;
        background: #fff; cursor: pointer; font-size: 13px; font-weight: 500;
        color: #212529;
        transition: all .12s ease;
      }
      button.btn svg { width: 13px; height: 13px; flex-shrink: 0; }
      button.btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(0,0,0,.08);
      }
      button.btn:disabled { opacity: .4; cursor: not-allowed; }
      /* Inline microphone-permission iframe — replaces the old separate
         window. Chrome anchors its mic prompt to the host page's address
         bar / "site information" UI, since the iframe is embedded here. */
      .mic-frame {
        display: block;
        width: 100%;
        height: 150px;
        border: 1px solid #e9ecef;
        border-radius: 6px;
        background: #fff;
        margin-top: 8px;
      }
      .mic-frame.hidden { display: none; }
      .btn.start { color: #c92a2a; border-color: #c92a2a; }
      .btn.stop  { color: #1864ab; border-color: #1864ab; }
      .btn.save  { color: #2b8a3e; border-color: #2b8a3e; }
      .btn.bug   { color: #fff; background: linear-gradient(135deg, #c92a2a 0%, #862e9c 100%); border-color: transparent; }
      .btn.bug:hover:not(:disabled) { filter: brightness(1.05); }
      .btn.start:hover:not(:disabled) { background: #fff5f5; }
      .btn.stop:hover:not(:disabled)  { background: #f1f7fc; }
      .btn.save:hover:not(:disabled)  { background: #f4faf6; }
      .btn.hidden { display: none; }

      /* ----- Bug modal ------------------------------------------------ */
      .scrim {
        position: fixed; inset: 0;
        background: rgba(20, 14, 30, 0.55);
        backdrop-filter: blur(3px);
        display: flex; align-items: center; justify-content: center;
        z-index: 1;
        animation: fadeIn .15s ease-out;
      }
      .scrim.hidden { display: none; }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      .modal {
        width: 420px; max-width: calc(100vw - 32px);
        max-height: calc(100vh - 64px);
        background: #1f1d28; color: #e9ecef;
        border-radius: 12px;
        box-shadow: 0 24px 60px rgba(0,0,0,.45);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: slideIn .18s ease-out;
      }
      .modal .mh {
        background: linear-gradient(135deg, #c92a2a 0%, #862e9c 100%);
        color: #fff; padding: 12px 16px;
        display: flex; align-items: center; justify-content: space-between;
        flex-shrink: 0;
      }
      .modal .mh strong { font-size: 14px; font-weight: 600; letter-spacing: .3px; }
      .modal .mb {
        padding: 14px 16px 4px;
        overflow-y: auto;
        flex: 1 1 auto;
      }
      .modal .mf {
        padding: 10px 16px 14px;
        border-top: 1px solid #2c2935;
        display: flex; gap: 8px; justify-content: flex-end;
        flex-shrink: 0;
      }
      .field { margin-bottom: 11px; }
      .field label {
        display: block; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .6px;
        color: #adb5bd; margin-bottom: 4px;
      }
      .field label .req { color: #ff8787; margin-left: 2px; }
      .field input, .field select, .field .combo-input {
        width: 100%;
        padding: 7px 10px;
        font: inherit; font-size: 13px;
        background: #15131c; color: #e9ecef;
        border: 1px solid #2c2935; border-radius: 6px;
        outline: none;
        transition: border-color .12s ease, box-shadow .12s ease;
      }
      .field input:focus, .field select:focus, .field .combo-input:focus {
        border-color: #862e9c;
        box-shadow: 0 0 0 2px rgba(134, 46, 156, .25);
      }
      .field input::placeholder, .field .combo-input::placeholder { color: #6c757d; }
      .field .hint {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.35;
        min-height: 14px;
        color: #adb5bd;
      }
      .field .hint.ok    { color: #8ce99a; }
      .field .hint.error { color: #ffa8a8; }
      .field .hint.busy  { color: #d0bfff; }
      /* ---- Screenshot paste area ---- */
      .paste-zone {
        border: 1px dashed #3a3447;
        border-radius: 6px;
        padding: 14px 10px;
        text-align: center;
        font-size: 12px;
        line-height: 1.4;
        color: #adb5bd;
        background: #15131c;
        cursor: pointer;
        outline: none;
        transition: border-color .12s ease, background .12s ease, color .12s ease;
      }
      .paste-zone:focus,
      .paste-zone.focused {
        border-color: #862e9c;
        background: #1a1726;
        color: #d0bfff;
      }
      .paste-zone .kbd {
        display: inline-block;
        padding: 1px 5px;
        margin: 0 2px;
        font-family: ui-monospace, "SF Mono", Consolas, Menlo, monospace;
        font-size: 10px;
        border: 1px solid #3a3447;
        border-radius: 3px;
        background: #221f2c;
        color: #e9ecef;
      }
      .thumbs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }
      .thumbs:empty { display: none; }
      .thumb {
        position: relative;
        width: 72px; height: 54px;
        border-radius: 4px;
        border: 1px solid #2c2935;
        overflow: hidden;
        background: #0e0d14;
      }
      .thumb img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumb .x {
        position: absolute;
        top: 2px; right: 2px;
        width: 16px; height: 16px;
        border-radius: 50%;
        background: rgba(0,0,0,.7);
        color: #fff;
        font-size: 12px; line-height: 14px;
        text-align: center;
        cursor: pointer;
        border: none;
        padding: 0;
      }
      .thumb .x:hover:not(:disabled) { background: rgba(201,42,42,.9); }
      .thumb .x:disabled { opacity: .4; cursor: not-allowed; }
      .field select { appearance: none; cursor: pointer;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='%23adb5bd' d='M5 6 0 0h10z'/></svg>");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 28px;
      }
      /* ---- Searchable combobox ---- */
      .combobox { position: relative; }
      .combo-input {
        padding-right: 28px !important;
        cursor: text;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='%23adb5bd' d='M5 6 0 0h10z'/></svg>");
        background-repeat: no-repeat;
        background-position: right 10px center;
      }
      .combo-list {
        position: fixed;          /* JS sets top/left/width on open() */
        z-index: 2147483647;      /* always above scrim + body content */
        max-height: 180px;        /* ~5 rows; rest scrolls inside the list */
        overflow-y: auto;
        background: #15131c;
        border: 1px solid #2c2935;
        border-radius: 6px;
        box-shadow: 0 8px 22px rgba(0,0,0,.4);
      }
      .combo-list.hidden { display: none; }
      .combo-opt {
        padding: 7px 10px;
        font-size: 13px;
        color: #e9ecef;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .combo-opt:hover, .combo-opt.active { background: #2a1f3d; color: #fff; }
      .combo-opt.empty {
        color: #6c757d; font-style: italic; cursor: default; padding: 8px 10px;
      }
      .combo-opt.empty:hover { background: transparent; color: #6c757d; }
      /* Scrollbar styling — keeps the dropdown looking integrated. */
      .combo-list::-webkit-scrollbar { width: 8px; }
      .combo-list::-webkit-scrollbar-thumb {
        background: #3a3447; border-radius: 4px;
      }
      .combo-list::-webkit-scrollbar-thumb:hover { background: #4d4560; }
      .combo-list::-webkit-scrollbar-track { background: transparent; }
      .row { display: flex; gap: 10px; }
      .row .field { flex: 1; }
      .modal button.mbtn {
        font: inherit; font-size: 13px; font-weight: 500;
        padding: 7px 14px; border-radius: 6px;
        border: 1px solid #2c2935; background: #15131c; color: #e9ecef;
        cursor: pointer;
        transition: all .12s ease;
      }
      .modal button.mbtn:hover:not(:disabled) { background: #221f2c; }
      .modal button.mbtn.primary {
        background: linear-gradient(135deg, #c92a2a 0%, #862e9c 100%);
        color: #fff; border-color: transparent;
      }
      .modal button.mbtn.primary:hover:not(:disabled) { filter: brightness(1.08); }
      .modal button.mbtn:disabled { opacity: .5; cursor: not-allowed; }
      .feedback {
        margin: 0 0 10px;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.4;
        word-break: break-word;
      }
      .feedback.hidden { display: none; }
      .feedback.info  { background: #1d1a26; border: 1px solid #322a45; color: #d0bfff; }
      .feedback.error { background: #2a1416; border: 1px solid #5a2228; color: #ffa8a8; }
      .feedback.ok    { background: #122019; border: 1px solid #1f4a35; color: #8ce99a; }
      .feedback a { color: inherit; text-decoration: underline; }
      .spinner {
        display: inline-block; width: 10px; height: 10px;
        border: 2px solid rgba(255,255,255,.25);
        border-top-color: #fff;
        border-radius: 50%; vertical-align: -1px;
        margin-right: 6px;
        animation: spin .8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <button class="fab" id="fab" title="BugScribe — click to record" aria-label="BugScribe">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="6" width="14" height="12" rx="2"/>
        <path d="M22 8l-6 4 6 4V8z"/>
      </svg>
    </button>
    <div class="panel hidden" id="panel">
      <div class="ph">
        <span class="brand">
          <svg class="cam" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="6" width="14" height="12" rx="2"/>
            <path d="M22 8l-6 4 6 4V8z"/>
          </svg>
          BugScribe
        </span>
        <button class="close" id="close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="pb">
        <div class="timer" id="timer">00:00</div>
        <div class="status" id="status">Idle</div>
        <button class="btn start" id="start" type="button">
          <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="5"/></svg>
          Start Recording
        </button>
        <button class="btn stop"  id="stop"  type="button" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
          Stop Recording
        </button>
        <button class="btn save"  id="save"  type="button" disabled>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 2v8"/><path d="M4 7l4 4 4-4"/><path d="M2 14h12"/>
          </svg>
          Save
        </button>
        <iframe class="mic-frame hidden" id="micFrame"
                allow="microphone"
                title="BugScribe microphone permission"></iframe>
        <button class="btn bug hidden" id="createBug" type="button">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="9" r="4"/>
            <path d="M8 5V3"/><path d="M6 4l-1-1"/><path d="M10 4l1-1"/>
            <path d="M2 9h2"/><path d="M12 9h2"/>
            <path d="M3 12l2-1"/><path d="M13 12l-2-1"/>
            <path d="M3 6l2 1"/><path d="M13 6l-2 1"/>
          </svg>
          Create Bug in Azure DevOps
        </button>
      </div>
    </div>

    <div class="scrim hidden" id="scrim">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="mh">
          <strong id="modalTitle">Create Work Item in Azure DevOps</strong>
          <button class="close" id="modalClose" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="mb">
          <div class="feedback hidden" id="feedback"></div>
          <div class="field">
            <label>Work Item Type <span class="req">*</span></label>
            <div class="combobox">
              <input class="combo-input" id="f-type" type="text" placeholder="Select type…" autocomplete="off" readonly />
              <div class="combo-list hidden" id="f-type-list"></div>
            </div>
          </div>
          <div class="field">
            <label for="f-title">Title <span class="req">*</span></label>
            <input id="f-title" type="text" maxlength="255" placeholder="Short summary" />
          </div>
          <div class="field">
            <label>Assign To</label>
            <div class="combobox">
              <input class="combo-input" id="f-assignee" type="text" placeholder="Search a team member…" autocomplete="off" />
              <div class="combo-list hidden" id="f-assignee-list"></div>
            </div>
          </div>
          <div class="field">
            <label>Area Path</label>
            <div class="combobox">
              <input class="combo-input" id="f-area" type="text" placeholder="Loading…" autocomplete="off" />
              <div class="combo-list hidden" id="f-area-list"></div>
            </div>
          </div>
          <div class="field">
            <label>Iteration Path</label>
            <div class="combobox">
              <input class="combo-input" id="f-iter" type="text" placeholder="Loading…" autocomplete="off" />
              <div class="combo-list hidden" id="f-iter-list"></div>
            </div>
          </div>
          <div class="field">
            <label for="f-parent">Parent Work Item</label>
            <input id="f-parent" type="text" inputmode="numeric" pattern="[0-9]*"
                   placeholder="Existing work item ID (e.g. 1234)" autocomplete="off" />
            <div class="hint" id="f-parent-hint"></div>
          </div>
          <div class="row">
            <div class="field">
              <label id="lbl-cat">Bug Category</label>
              <div class="combobox">
                <input class="combo-input" id="f-cat" type="text" placeholder="Search…" autocomplete="off" />
                <div class="combo-list hidden" id="f-cat-list"></div>
              </div>
            </div>
            <div class="field">
              <label>Priority</label>
              <div class="combobox">
                <input class="combo-input" id="f-prio" type="text" placeholder="Select…" autocomplete="off" readonly />
                <div class="combo-list hidden" id="f-prio-list"></div>
              </div>
            </div>
            <div class="field" id="field-sev">
              <label>Severity</label>
              <div class="combobox">
                <input class="combo-input" id="f-sev" type="text" placeholder="Select…" autocomplete="off" readonly />
                <div class="combo-list hidden" id="f-sev-list"></div>
              </div>
            </div>
          </div>
          <div class="field">
            <label>Screenshots</label>
            <div class="paste-zone" id="paste-zone" tabindex="0"
                 role="button" aria-label="Paste screenshot area">
              Click here, then press <span class="kbd">Ctrl</span>+<span class="kbd">V</span> to paste a screenshot
            </div>
            <div class="thumbs" id="thumbs"></div>
          </div>
        </div>
        <div class="mf">
          <button class="mbtn" id="modalCancel" type="button">Cancel</button>
          <button class="mbtn primary" id="modalSubmit" type="button">Submit</button>
        </div>
      </div>
    </div>
  `;

  // Defer mounting until <body> exists.
  function mount() {
    (document.body || document.documentElement).appendChild(host);
    // Pull the persisted FAB position (if any) and apply it asynchronously.
    // Defined later in the file once the host element is available; we
    // forward-reference it via setTimeout so the closure is in place.
    setTimeout(() => { try { restorePosition(); } catch {} }, 0);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  const fab     = root.getElementById('fab');
  const panel   = root.getElementById('panel');
  const closeBtn= root.getElementById('close');
  const timerEl = root.getElementById('timer');
  const statusEl= root.getElementById('status');
  const startBtn= root.getElementById('start');
  const stopBtn = root.getElementById('stop');
  const saveBtn = root.getElementById('save');
  const bugBtn  = root.getElementById('createBug');
  const micFrame = root.getElementById('micFrame');

  const scrim   = root.getElementById('scrim');
  const modalClose = root.getElementById('modalClose');
  const modalCancel = root.getElementById('modalCancel');
  const modalSubmit = root.getElementById('modalSubmit');
  const fTitle  = root.getElementById('f-title');
  const fParent = root.getElementById('f-parent');
  const fParentHint = root.getElementById('f-parent-hint');
  const pasteZone = root.getElementById('paste-zone');
  const thumbs   = root.getElementById('thumbs');
  const lblCat  = root.getElementById('lbl-cat');
  const fieldSev = root.getElementById('field-sev');
  const feedback = root.getElementById('feedback');

  // Searchable combobox controllers — one per dropdown. Built lazily after
  // the helper is defined below.
  let cbType, cbAssign, cbArea, cbIter, cbCat, cbPrio, cbSev;

  // Per-work-item-type field metadata cached after first lookup. Each entry:
  //   { fields: Map<refName, fieldMeta>, categoryRef: string|null }
  // We use this on submit to (a) resolve the Category reference name and
  // (b) skip fields that don't exist on the chosen type (e.g. Severity
  // typically isn't on Suggestion).
  const typeMetaCache = new Map();
  let currentType = 'Bug';

  let timerHandle = null;
  let currentFilename = null;
  let modalLoaded = false;

  // One-time diagnostic so users can confirm whether the build picked up
  // the .env values. If AZURE_ENABLED is false here, the "Create Bug"
  // button stays hidden — fix .env and rebuild.
  console.info('[BugScribe] Azure DevOps integration:',
    AZURE_ENABLED ? 'enabled' : 'DISABLED (missing .env values at build time)',
    { org: AZURE.org || '(empty)', project: AZURE.project || '(empty)', patLength: AZURE.pat.length });

  // -------------------------------------------------------------------------
  //  Searchable combobox
  // -------------------------------------------------------------------------
  // Lightweight replacement for <select>: an <input> filters a list as the
  // user types, arrow keys + Enter navigate, click selects. The CSS caps the
  // list at ~5 rows; anything past that scrolls.
  //
  // `allowFreeText` lets the user submit whatever they typed (used for the
  // Assign-To field, where emails outside the listed team are sometimes
  // legitimate). All other comboboxes are pick-from-list only.
  function makeCombobox({ inputId, listId, items, placeholder, allowFreeText, onChange }) {
    const input = root.getElementById(inputId);
    const list  = root.getElementById(listId);
    let opts = normalize(items || []);
    let value = '';        // submitted value (option.value)
    let label = '';        // displayed text (option.label)
    let activeIdx = -1;
    if (placeholder) input.placeholder = placeholder;

    function normalize(arr) {
      return (arr || []).map(it => typeof it === 'string' ? { value: it, label: it } : it);
    }

    function render(filter) {
      list.innerHTML = '';
      const f = (filter || '').toLowerCase().trim();
      const filtered = f
        ? opts.filter(o => (o.label || '').toLowerCase().includes(f))
        : opts.slice();
      activeIdx = filtered.length ? 0 : -1;
      if (!filtered.length) {
        const el = document.createElement('div');
        el.className = 'combo-opt empty';
        el.textContent = opts.length ? 'No matches' : 'No options';
        list.appendChild(el);
        return;
      }
      filtered.forEach((o, i) => {
        const el = document.createElement('div');
        el.className = 'combo-opt' + (i === activeIdx ? ' active' : '');
        el.textContent = o.label;
        el.dataset.value = String(o.value);
        // mousedown (not click) so blur on input fires after selection.
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(o); });
        el.addEventListener('mouseenter', () => {
          activeIdx = i;
          [...list.children].forEach((c, j) => c.classList.toggle('active', j === activeIdx));
        });
        list.appendChild(el);
      });
    }

    function open(filter) {
      // Default to "show everything" when the user clicks/focuses the
      // input — otherwise the pre-selected value would filter the list
      // down to a single match (e.g. opening Type while it reads "Bug"
      // would hide Suggestion).
      positionList();
      render(filter === undefined ? '' : filter);
      list.classList.remove('hidden');
    }
    function close() { list.classList.add('hidden'); }

    function positionList() {
      // The dropdown lives inside the scrollable modal body, so a plain
      // `position: absolute` lets long lists push the body scrollbar.
      // Pin it to viewport coords with `position: fixed` and compute
      // top/left/width from the input on every open so it escapes the
      // scroll container entirely.
      const rect = input.getBoundingClientRect();
      list.style.position = 'fixed';
      list.style.top      = (rect.bottom + 2) + 'px';
      list.style.left     = rect.left + 'px';
      list.style.width    = rect.width + 'px';
      list.style.right    = 'auto';
    }

    function pick(o) {
      value = o.value;
      label = o.label;
      input.value = o.label;
      close();
      if (onChange) onChange(value);
    }

    input.addEventListener('focus', () => open());
    input.addEventListener('click', () => open());
    input.addEventListener('input', () => {
      // While typing, the value isn't committed until the user picks an
      // option (or blurs with an exact match, see below). Pass the current
      // input as the filter so the list narrows down as the user types.
      if (!input.readOnly) {
        value = allowFreeText ? input.value : '';
        label = input.value;
        open(input.value);
      }
    });
    input.addEventListener('keydown', (e) => {
      const visible = list.querySelectorAll('.combo-opt:not(.empty)');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.classList.contains('hidden')) open();
        if (!visible.length) return;
        activeIdx = Math.min(visible.length - 1, activeIdx + 1);
        visible.forEach((c, i) => c.classList.toggle('active', i === activeIdx));
        visible[activeIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!visible.length) return;
        activeIdx = Math.max(0, activeIdx - 1);
        visible.forEach((c, i) => c.classList.toggle('active', i === activeIdx));
        visible[activeIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const el = visible[activeIdx];
        if (el) {
          e.preventDefault();
          const o = opts.find(o => String(o.value) === el.dataset.value);
          if (o) pick(o);
        }
      } else if (e.key === 'Escape') {
        close();
      }
    });
    input.addEventListener('blur', () => {
      // Small delay so a click on an option still fires `mousedown` first.
      setTimeout(() => {
        close();
        if (!allowFreeText) {
          // Snap to an exact match if the typed text matches a label
          // (case-insensitive). Otherwise revert to the last committed value
          // so the form doesn't drift into an invalid state.
          const typed = input.value.toLowerCase().trim();
          const exact = opts.find(o => (o.label || '').toLowerCase().trim() === typed);
          if (exact) {
            value = exact.value; label = exact.label; input.value = exact.label;
          } else {
            input.value = label;
          }
        }
      }, 120);
    });

    return {
      get value() { return value; },
      get label() { return label; },
      setOptions(newItems) {
        opts = normalize(newItems);
        value = ''; label = ''; input.value = '';
      },
      setValue(v) {
        const o = opts.find(o => String(o.value) === String(v));
        if (o) { value = o.value; label = o.label; input.value = o.label; }
        else   { value = ''; label = ''; input.value = ''; }
      },
      clear() { value = ''; label = ''; input.value = ''; }
    };
  }

  // A fixed-positioned dropdown stays put while the input under it moves
  // when the body scrolls or the window resizes — close all open lists in
  // those cases so the UI never shows a detached dropdown.
  function closeAllComboLists() {
    root.querySelectorAll('.combo-list:not(.hidden)').forEach(l => l.classList.add('hidden'));
  }
  const modalBodyEl = root.querySelector('.modal .mb');
  if (modalBodyEl) modalBodyEl.addEventListener('scroll', closeAllComboLists, { passive: true });
  window.addEventListener('resize', closeAllComboLists);

  // Build all comboboxes. The category set is rebuilt every time the work
  // item type changes (see onTypeChange below).
  cbType = makeCombobox({
    inputId: 'f-type', listId: 'f-type-list',
    items: WORK_ITEM_TYPES,
    placeholder: 'Select type…',
    onChange: (v) => onTypeChange(v)
  });
  cbAssign = makeCombobox({
    inputId: 'f-assignee', listId: 'f-assignee-list',
    items: [], placeholder: 'Search a team member…',
    allowFreeText: true
  });
  cbArea = makeCombobox({
    inputId: 'f-area', listId: 'f-area-list',
    items: [], placeholder: 'Search area path…'
  });
  cbIter = makeCombobox({
    inputId: 'f-iter', listId: 'f-iter-list',
    items: [], placeholder: 'Search iteration path…'
  });
  cbCat = makeCombobox({
    inputId: 'f-cat', listId: 'f-cat-list',
    items: CATEGORIES_BY_TYPE['Bug'],
    placeholder: 'Search…'
  });
  cbPrio = makeCombobox({
    inputId: 'f-prio', listId: 'f-prio-list',
    items: ['1', '2', '3', '4'],
    placeholder: 'Select…'
  });
  cbSev = makeCombobox({
    inputId: 'f-sev', listId: 'f-sev-list',
    items: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'],
    placeholder: 'Select…'
  });
  // Reasonable defaults for triage fields. setValue does not fire onChange,
  // so we set the submit-button label explicitly to match the default type.
  cbType.setValue('Bug');
  cbPrio.setValue('2');
  cbSev.setValue('3 - Medium');
  modalSubmit.textContent = 'Submit Bug';

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function startTimer(t) {
    stopTimer();
    const tick = () => { timerEl.textContent = fmt(Date.now() - t); };
    tick();
    timerHandle = setInterval(tick, 500);
  }
  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  async function getState() {
    try { return await chrome.storage.session.get(null); }
    catch { return {}; }
  }

  async function refresh() {
    const s = await getState();
    fab.classList.remove('recording', 'processing');
    if (s.isRecording) {
      fab.classList.add('recording');
      statusEl.innerHTML = '<span class="rdot"></span>Recording…';
      startBtn.disabled = true; stopBtn.disabled = false; saveBtn.disabled = true;
      bugBtn.classList.add('hidden');
      if (s.startTime) startTimer(s.startTime);
    } else if (s.processing) {
      fab.classList.add('processing');
      const pct = typeof s.processingProgress === 'number' ? s.processingProgress : null;
      const stage = s.processingStage === 'finalizing' ? 'finalizing' : 'encoding MP4';
      statusEl.textContent = pct === null
        ? 'Processing… (' + stage + ')'
        : 'Processing… ' + pct + '% (' + stage + ')';
      startBtn.disabled = true; stopBtn.disabled = true; saveBtn.disabled = true;
      bugBtn.classList.add('hidden');
      stopTimer();
    } else {
      // Three distinct idle sub-states drive the prompt text and which
      // buttons light up:
      //   - error:    something went wrong
      //   - readyToSave: MP4 is in memory, user has not clicked Save yet
      //   - saved:    user clicked Save; Create Bug is now available
      //   - fresh:    no recording yet
      const readyToSave = !!s.lastFilename && !s.savedToDisk;
      const saved       = !!s.lastFilename &&  s.savedToDisk;
      statusEl.textContent =
        s.lastError ? ('Error: ' + s.lastError) :
        readyToSave ? 'Recording ready — click Save to download the MP4.' :
        saved       ? ('Saved: ' + s.lastFilename)
                    : 'Idle';
      startBtn.disabled = false; stopBtn.disabled = true; saveBtn.disabled = !s.lastFilename;
      currentFilename = s.lastFilename || null;
      // Create Bug only after the user has explicitly saved the recording —
      // this is the "save first, then file a bug" flow.
      if (saved && AZURE_ENABLED) {
        bugBtn.classList.remove('hidden');
      } else {
        bugBtn.classList.add('hidden');
      }
      stopTimer();
      timerEl.textContent = '00:00';
    }
  }

  // ----- Draggable FAB ---------------------------------------------------
  // The widget defaults to the bottom-right corner. The user can drag it
  // anywhere in the viewport; the position is saved in chrome.storage.local
  // so it's restored on later page loads.
  //
  // Click vs. drag is distinguished by a pixel threshold: pointer movement
  // under DRAG_THRESHOLD px before pointerup is treated as a click (open/
  // close the panel). Anything beyond that is a drag and the next click
  // event is suppressed.
  const DRAG_THRESHOLD = 4;
  const EDGE_MARGIN = 4; // keep the FAB at least this many px from the viewport edges
  const FAB_POS_KEY = 'bugscribeFabPos';

  let dragState = null;
  let suppressNextClick = false;
  let panelOpenSide = { vertical: 'up', horizontal: 'left' }; // direction the panel opens

  function setHostPosition(left, top) {
    host.style.left = left + 'px';
    host.style.top  = top  + 'px';
    host.style.right  = 'auto';
    host.style.bottom = 'auto';
  }

  function clampToViewport(left, top) {
    const w = host.offsetWidth  || 52;
    const h = host.offsetHeight || 52;
    const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth  - w - EDGE_MARGIN);
    const maxTop  = Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN);
    return {
      left: Math.max(EDGE_MARGIN, Math.min(maxLeft, left)),
      top:  Math.max(EDGE_MARGIN, Math.min(maxTop,  top))
    };
  }

  function positionPanel() {
    // Auto-flip the panel so it doesn't run off-screen when the FAB sits
    // near a viewport edge. Defaults match the original layout (panel opens
    // up and to the left of the FAB).
    if (panel.classList.contains('hidden')) return;
    const fabRect = fab.getBoundingClientRect();
    const panelW = panel.offsetWidth  || 260;
    const panelH = panel.offsetHeight || 320;
    const gap = 12;

    const openDown  = fabRect.top    < panelH + gap;
    const openRight = fabRect.right  < panelW;

    if (openDown) {
      panel.style.top = (fab.offsetHeight + gap) + 'px';
      panel.style.bottom = 'auto';
    } else {
      panel.style.bottom = (fab.offsetHeight + gap) + 'px';
      panel.style.top = 'auto';
    }
    if (openRight) {
      panel.style.left = '0';
      panel.style.right = 'auto';
    } else {
      panel.style.right = '0';
      panel.style.left = 'auto';
    }
    panelOpenSide = { vertical: openDown ? 'down' : 'up', horizontal: openRight ? 'right' : 'left' };
  }

  function savePosition() {
    try {
      const rect = host.getBoundingClientRect();
      chrome.storage?.local?.set?.({
        [FAB_POS_KEY]: { left: Math.round(rect.left), top: Math.round(rect.top) }
      }).catch(() => {});
    } catch {}
  }

  async function restorePosition() {
    try {
      const { [FAB_POS_KEY]: saved } = await chrome.storage.local.get(FAB_POS_KEY);
      if (!saved) return;
      const clamped = clampToViewport(saved.left, saved.top);
      setHostPosition(clamped.left, clamped.top);
    } catch {}
  }

  fab.addEventListener('pointerdown', (e) => {
    // Only the primary (left) button starts a drag. Right-click / middle
    // are left alone so the page or browser can use them normally.
    if (e.button !== undefined && e.button !== 0) return;
    const rect = host.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabOffsetX: e.clientX - rect.left,
      grabOffsetY: e.clientY - rect.top,
      dragging: false
    };
    try { fab.setPointerCapture(e.pointerId); } catch {}
  });

  fab.addEventListener('pointermove', (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!dragState.dragging) {
      dragState.dragging = true;
      fab.classList.add('dragging');
      // Close the panel while dragging — it would lag behind otherwise.
      panel.classList.add('hidden');
    }
    const next = clampToViewport(
      e.clientX - dragState.grabOffsetX,
      e.clientY - dragState.grabOffsetY
    );
    setHostPosition(next.left, next.top);
  });

  function endDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const wasDrag = dragState.dragging;
    try { fab.releasePointerCapture(dragState.pointerId); } catch {}
    dragState = null;
    if (wasDrag) {
      fab.classList.remove('dragging');
      suppressNextClick = true;
      savePosition();
    }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);

  // Keep the FAB inside the viewport when the window is resized while the
  // user has it stashed near an edge.
  window.addEventListener('resize', () => {
    const rect = host.getBoundingClientRect();
    // Only re-clamp if we've moved off the default bottom-right corner.
    if (host.style.left || host.style.top) {
      const clamped = clampToViewport(rect.left, rect.top);
      setHostPosition(clamped.left, clamped.top);
    }
    if (!panel.classList.contains('hidden')) positionPanel();
  });

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    if (suppressNextClick) {
      // The pointerup that ended a drag also produces a click — swallow it
      // so the panel doesn't toggle as a side effect of moving the FAB.
      suppressNextClick = false;
      return;
    }
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) positionPanel();
    refresh();
  });
  closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    // Click outside the widget collapses the panel. Don't collapse while
    // the modal is open — clicks land on the scrim, not the page.
    if (!scrim.classList.contains('hidden')) return;
    if (!panel.classList.contains('hidden') && !host.contains(e.target)) {
      panel.classList.add('hidden');
    }
  });

  startBtn.addEventListener('click', async () => {
    statusEl.textContent = 'Starting…';
    try {
      const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'start' });
      if (!resp || !resp.ok) throw new Error(resp?.error || 'Failed to start');
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    }
    refresh();
  });

  stopBtn.addEventListener('click', async () => {
    statusEl.textContent = 'Stopping…';
    stopBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
      if (!resp || !resp.ok) throw new Error(resp?.error || 'Failed to stop');
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    }
    refresh();
  });

  saveBtn.addEventListener('click', async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'save' });
      if (!resp || !resp.ok) throw new Error(resp?.error || 'Save failed');
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    }
  });

  // ----- Bug modal --------------------------------------------------------

  function showFeedback(kind, html) {
    feedback.className = 'feedback ' + kind;
    feedback.innerHTML = html;
  }
  function clearFeedback() {
    feedback.className = 'feedback hidden';
    feedback.innerHTML = '';
  }

  function setFormDisabled(disabled) {
    // Disable inputs (including the comboboxes' internal <input>s).
    root.querySelectorAll('.modal input, .modal .combo-input, .modal .mbtn, .modal .close')
        .forEach(el => { el.disabled = disabled; });
    // Screenshot paste area: keep it visually present but reject new pastes
    // and remove clicks while uploads are running.
    screenshotsLocked = disabled;
    pasteZone.tabIndex = disabled ? -1 : 0;
    pasteZone.style.pointerEvents = disabled ? 'none' : '';
    pasteZone.style.opacity = disabled ? '0.6' : '';
    thumbs.querySelectorAll('button.x').forEach(b => { b.disabled = disabled; });
  }

  async function getTypeMeta(workItemType) {
    // Cached per-type field catalog. Resolves both the category field's
    // referenceName and the set of fields that actually exist on the type,
    // so submit can skip Severity on a Suggestion etc.
    if (typeMetaCache.has(workItemType)) return typeMetaCache.get(workItemType);
    const fieldList = await listFieldsForType({ ...AZURE, workItemType });
    const refs = new Set(fieldList.map(f => f.referenceName));
    const catField = findFieldByDisplayName(fieldList, CATEGORY_FIELD_DISPLAY_NAME[workItemType] || 'Category');
    const meta = { refs, categoryRef: catField?.referenceName || null };
    typeMetaCache.set(workItemType, meta);
    return meta;
  }

  async function onTypeChange(newType) {
    if (!newType || newType === currentType) return;
    currentType = newType;
    // Relabel + repopulate the category dropdown.
    lblCat.textContent = CATEGORY_LABEL_BY_TYPE[newType] || 'Category';
    cbCat.setOptions(CATEGORIES_BY_TYPE[newType] || []);
    // Discover this type's category field reference name and toggle
    // Severity visibility based on whether the type carries it.
    try {
      const meta = await getTypeMeta(newType);
      fieldSev.style.display = meta.refs.has('Microsoft.VSTS.Common.Severity') ? '' : 'none';
      console.info('[BugScribe]', newType, 'category ref:', meta.categoryRef || '(not found — falling back to tag)');
    } catch (err) {
      console.warn('[bugscribe] failed to load fields for', newType, err);
    }
    modalSubmit.textContent = newType === 'Bug' ? 'Submit Bug' : 'Submit ' + newType;
  }

  async function loadAzureMetadata() {
    if (modalLoaded) return;
    showFeedback('info', '<span class="spinner"></span>Loading project metadata…');
    const [members, areas, iters] = await Promise.all([
      listTeamMembers(AZURE).catch(err => { console.warn('[bugscribe] team members:', err); return []; }),
      listAreaPaths(AZURE).catch(err => { console.warn('[bugscribe] area paths:', err); return []; }),
      listIterationPaths(AZURE).catch(err => { console.warn('[bugscribe] iterations:', err); return []; })
    ]);

    cbAssign.setOptions(members.map(m => ({
      // System.AssignedTo accepts uniqueName (email) or displayName; we
      // send uniqueName when available because it's globally unambiguous.
      value: m.uniqueName || m.displayName,
      label: m.displayName + (m.uniqueName ? ` <${m.uniqueName}>` : '')
    })));
    cbArea.setOptions(areas);
    cbIter.setOptions(iters);

    if (!members.length && !areas.length && !iters.length) {
      showFeedback('error',
        'Could not reach Azure DevOps. Check your PAT scopes and that ' +
        '<code>' + escapeHtml(AZURE.org) + '</code> / <code>' +
        escapeHtml(AZURE.project) + '</code> are correct.');
    } else {
      clearFeedback();
      modalLoaded = true;
    }
    // Pre-warm the field catalog for the initially-selected type so the
    // submit doesn't pay for the extra round-trip, and hide Severity if
    // the type doesn't carry it. Subsequent type changes route through
    // onTypeChange which uses the same cache.
    try {
      const meta = await getTypeMeta(currentType);
      fieldSev.style.display = meta.refs.has('Microsoft.VSTS.Common.Severity') ? '' : 'none';
      console.info('[BugScribe]', currentType, 'category ref:', meta.categoryRef || '(not found — falling back to tag)');
    } catch (err) {
      console.warn('[bugscribe] failed to load fields for', currentType, err);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ----- Parent work item lookup -----------------------------------------
  // The user types an ID; on blur we fetch the work item and show its
  // title inline so they can confirm before submitting. `parentValidated`
  // tracks whether the currently-typed value has been resolved, so submit
  // can reject stale input without making an extra API call.
  let parentValidated = { id: null, ok: false };
  let parentLookupSeq = 0;

  function setParentHint(kind, text) {
    fParentHint.className = 'hint' + (kind ? ' ' + kind : '');
    fParentHint.textContent = text || '';
  }

  function parseParentId(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    // Accept either a plain number or a full Azure work-item URL ending in
    // `/edit/1234` — paste-friendly, since reporters often copy the link.
    const m = trimmed.match(/(\d+)\s*$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async function validateParent() {
    const raw = fParent.value;
    if (!raw.trim()) {
      parentValidated = { id: null, ok: true };
      setParentHint('', '');
      return;
    }
    const id = parseParentId(raw);
    if (id === null) {
      parentValidated = { id: null, ok: false };
      setParentHint('error', 'Enter a numeric work item ID.');
      return;
    }
    // Normalize the field to the parsed number so URLs paste-and-resolve.
    fParent.value = String(id);

    const seq = ++parentLookupSeq;
    setParentHint('busy', 'Looking up #' + id + '…');
    try {
      const wi = await getWorkItem({ ...AZURE, workItemId: id });
      if (seq !== parentLookupSeq) return; // a newer lookup superseded us
      const type = wi.fields?.['System.WorkItemType'] || 'Work Item';
      const title = wi.fields?.['System.Title'] || '(untitled)';
      parentValidated = { id, ok: true };
      setParentHint('ok', '✓ ' + type + ' #' + id + ': ' + title);
    } catch (err) {
      if (seq !== parentLookupSeq) return;
      parentValidated = { id, ok: false };
      setParentHint('error', 'Could not find work item #' + id + ' (' + err.message + ').');
    }
  }

  fParent.addEventListener('blur', validateParent);
  fParent.addEventListener('input', () => {
    // Any keystroke invalidates the cached lookup so submit re-checks it.
    parentValidated = { id: null, ok: false };
    if (!fParent.value.trim()) setParentHint('', '');
  });

  // ----- Screenshot paste area -------------------------------------------
  // Users press Print Screen / Snip & Sketch / Win+Shift+S, then paste into
  // the modal. We capture any image MIME on the clipboard, render a small
  // thumbnail strip, and upload each one as an attachment after the work
  // item is created.
  const screenshots = []; // [{ id, blob, objectURL, filename }]
  let nextScreenshotId = 0;
  let screenshotsLocked = false;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function makeScreenshotFilename(blob, id) {
    const d = new Date();
    const ts =
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
    // `image/png` → `png`, `image/jpeg` → `jpg`. Default to png if unknown
    // so Azure renders the preview inline.
    let ext = (blob.type || 'image/png').split('/')[1] || 'png';
    ext = ext.split(';')[0];
    if (ext === 'jpeg') ext = 'jpg';
    return `screenshot_${ts}_${id}.${ext}`;
  }

  function renderThumbs() {
    thumbs.innerHTML = '';
    for (const sc of screenshots) {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      wrap.title = sc.filename;
      const img = document.createElement('img');
      img.src = sc.objectURL;
      img.alt = sc.filename;
      wrap.appendChild(img);
      const x = document.createElement('button');
      x.className = 'x';
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + sc.filename);
      x.disabled = screenshotsLocked;
      x.addEventListener('click', () => removeScreenshot(sc.id));
      wrap.appendChild(x);
      thumbs.appendChild(wrap);
    }
  }

  function addScreenshot(blob) {
    const id = ++nextScreenshotId;
    screenshots.push({
      id,
      blob,
      objectURL: URL.createObjectURL(blob),
      filename: makeScreenshotFilename(blob, id)
    });
    renderThumbs();
  }

  function removeScreenshot(id) {
    const idx = screenshots.findIndex(s => s.id === id);
    if (idx < 0) return;
    try { URL.revokeObjectURL(screenshots[idx].objectURL); } catch {}
    screenshots.splice(idx, 1);
    renderThumbs();
  }

  function clearScreenshots() {
    for (const sc of screenshots) {
      try { URL.revokeObjectURL(sc.objectURL); } catch {}
    }
    screenshots.length = 0;
    renderThumbs();
  }

  function handlePaste(e) {
    if (scrim.classList.contains('hidden') || screenshotsLocked) return;
    const items = e.clipboardData?.items || [];
    let captured = false;
    for (const it of items) {
      // `kind === 'file'` is what Snipping Tool / Win+Shift+S produce. We
      // ignore plain `image/*` strings so HTML pastes don't get hijacked.
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          addScreenshot(f);
          captured = true;
        }
      }
    }
    if (captured) e.preventDefault();
  }

  // Paste events fire on the focused element and bubble. Listen on the
  // modal body so we catch pastes from any descendant (the paste-zone
  // itself, the title input, etc.) — text inputs only get hijacked when
  // the clipboard actually contains an image, so normal text paste still
  // works.
  const modalBodyForPaste = root.querySelector('.modal .mb');
  modalBodyForPaste.addEventListener('paste', handlePaste);
  pasteZone.addEventListener('click', () => pasteZone.focus());
  pasteZone.addEventListener('keydown', (e) => {
    // Space/Enter on the focused zone shouldn't scroll the body or submit.
    if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  });

  function openModal() {
    if (!AZURE_ENABLED) {
      statusEl.textContent = 'Error: Azure DevOps credentials not configured at build time.';
      return;
    }
    if (!currentFilename) {
      statusEl.textContent = 'Error: No recording to attach.';
      return;
    }
    scrim.classList.remove('hidden');
    // Default the title to the page title — most reporters want to keep it.
    if (!fTitle.value) fTitle.value = (document.title || '').slice(0, 200);
    // Parent link is per-submission; clear any prior value/hint.
    fParent.value = '';
    parentValidated = { id: null, ok: true };
    setParentHint('', '');
    // Screenshots are also per-submission — drop any leftovers.
    screenshotsLocked = false;
    clearScreenshots();
    setFormDisabled(false);
    fTitle.focus();
    loadAzureMetadata();
  }

  function closeModal() {
    scrim.classList.add('hidden');
    clearFeedback();
    // Free preview object URLs so closing without submitting doesn't leak.
    clearScreenshots();
    screenshotsLocked = false;
  }

  bugBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  // Clicking outside the modal closes it. Tricky case: combo-list options
  // are position:fixed and paint over the scrim. When the user clicks an
  // option, mousedown lands on the option and pick() hides the list — so
  // mouseup ends up on the scrim and the browser fires a synthetic click
  // on the common ancestor (the scrim), which would close the modal.
  // Guard by requiring both mousedown and click to originate on the scrim
  // itself; an option's mousedown never bubbles through the scrim with
  // target===scrim, so the dismiss only fires for genuine backdrop taps.
  let scrimDownOnSelf = false;
  scrim.addEventListener('mousedown', (e) => { scrimDownOnSelf = (e.target === scrim); });
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim && scrimDownOnSelf) closeModal();
    scrimDownOnSelf = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeModal();
  });

  modalSubmit.addEventListener('click', async () => {
    const title = fTitle.value.trim();
    const workItemType = cbType.value || 'Bug';
    if (!title) {
      showFeedback('error', 'Title is required.');
      fTitle.focus();
      return;
    }
    if (!currentFilename) {
      showFeedback('error', 'No recording is available to attach.');
      return;
    }

    // Make sure we have the field catalog cached so we can skip Severity
    // when the chosen type doesn't carry it, and resolve the Category ref.
    let meta;
    try {
      meta = await getTypeMeta(workItemType);
    } catch (err) {
      showFeedback('error', `Failed to load fields for ${workItemType}: ${escapeHtml(err.message)}`);
      return;
    }

    // Resolve the parent link, if any. If the user typed but never blurred,
    // run the lookup now so we don't POST a link to a non-existent ID.
    const parentRaw = fParent.value.trim();
    let parentId = null;
    if (parentRaw) {
      if (!parentValidated.ok || parentValidated.id !== parseParentId(parentRaw)) {
        await validateParent();
      }
      if (!parentValidated.ok || !parentValidated.id) {
        showFeedback('error', 'Parent work item could not be resolved. Fix the ID or clear the field.');
        fParent.focus();
        return;
      }
      parentId = parentValidated.id;
    }

    const category = cbCat.value;
    const fields = {
      // System.Title is the only strictly required field; everything else is
      // optional and gets filtered out when empty by createWorkItem().
      'System.Title': title,
      'System.AssignedTo': cbAssign.value || undefined,
      'System.AreaPath': cbArea.value || undefined,
      'System.IterationPath': cbIter.value || undefined,
      'Microsoft.VSTS.Common.Priority': cbPrio.value ? Number(cbPrio.value) : undefined
    };
    // Severity is typically Bug-only; only include it when the type
    // catalog actually has the field.
    if (cbSev.value && meta.refs.has('Microsoft.VSTS.Common.Severity')) {
      fields['Microsoft.VSTS.Common.Severity'] = cbSev.value;
    }
    // Category goes into the discovered field for this type. Fall back to
    // a tag if the type has no such field (stock process).
    if (category) {
      if (meta.categoryRef) {
        fields[meta.categoryRef] = category;
      } else {
        const prefix = workItemType === 'Bug' ? 'BugCategory: ' : 'Category: ';
        fields['System.Tags'] = prefix + category;
      }
    }

    const relations = parentId
      ? [parentLinkRelation({ org: AZURE.org, parentId })]
      : undefined;

    setFormDisabled(true);
    try {
      showFeedback('info', `<span class="spinner"></span>Creating ${workItemType.toLowerCase()}…`);
      const created = await createWorkItem({ ...AZURE, workItemType, fields, relations });
      const wid = created.id;

      showFeedback('info', `<span class="spinner"></span>Uploading MP4 attachment (work item #${wid})…`);
      // The MP4 blob lives in the offscreen document — hand off the upload
      // there. Background routes the message to offscreen and back.
      const attach = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'azure-attach',
        workItemId: wid,
        filename: currentFilename,
        azure: AZURE
      });
      const url = workItemUrl({ ...AZURE, workItemId: wid });
      const mp4Ok = !!(attach && attach.ok);
      const mp4Err = mp4Ok ? null : (attach?.error || 'Attachment failed');

      // Upload pasted screenshots, if any. Each one is independent — a
      // failure on one shouldn't drop the others, and shouldn't block the
      // success message for what did make it in.
      const screenshotResults = [];
      for (let i = 0; i < screenshots.length; i++) {
        const sc = screenshots[i];
        showFeedback(
          'info',
          `<span class="spinner"></span>Uploading screenshot ${i + 1} of ${screenshots.length}…`
        );
        try {
          const uploaded = await uploadAttachment({
            ...AZURE, blob: sc.blob, filename: sc.filename
          });
          await linkAttachment({
            ...AZURE,
            workItemId: wid,
            attachmentUrl: uploaded.url,
            filename: sc.filename
          });
          screenshotResults.push({ ok: true, filename: sc.filename });
        } catch (err) {
          console.error('[bugscribe] screenshot upload failed:', sc.filename, err);
          screenshotResults.push({ ok: false, filename: sc.filename, error: err.message });
        }
      }
      const shotOk = screenshotResults.filter(r => r.ok).length;
      const shotFail = screenshotResults.length - shotOk;

      const link = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">#${wid}</a>`;
      const typeLabel = escapeHtml(workItemType.toLowerCase());

      if (!mp4Ok && shotFail === screenshotResults.length) {
        // Nothing attached at all.
        const tail = screenshotResults.length
          ? ` MP4 upload failed (${escapeHtml(mp4Err)}); all ${screenshotResults.length} screenshots also failed.`
          : ` MP4 upload failed: ${escapeHtml(mp4Err)}`;
        showFeedback('error', `${escapeHtml(workItemType)} ${link} created, but${tail}`);
      } else if (!mp4Ok || shotFail > 0) {
        // Partial success — work item + some attachments.
        const parts = [];
        if (mp4Ok) parts.push('recording attached');
        else parts.push(`MP4 upload failed (${escapeHtml(mp4Err)})`);
        if (shotOk) parts.push(`${shotOk} screenshot${shotOk === 1 ? '' : 's'} attached`);
        if (shotFail) parts.push(`${shotFail} screenshot upload${shotFail === 1 ? '' : 's'} failed`);
        showFeedback('error', `Created ${typeLabel} ${link} — ${parts.join('; ')}.`);
      } else {
        const extras = shotOk
          ? ` with the recording and ${shotOk} screenshot${shotOk === 1 ? '' : 's'} attached.`
          : ' with the recording attached.';
        showFeedback('ok', `Created ${typeLabel} ${link}${extras}`);
      }
    } catch (err) {
      console.error('[bugscribe] submit failed:', err);
      showFeedback('error', escapeHtml(err.message || 'Failed to create work item.'));
    } finally {
      setFormDisabled(false);
    }
  });

  // ----- Inline microphone permission flow -------------------------------
  // When the background needs mic access, it asks us to embed the
  // permissions page as an iframe. The iframe's getUserMedia call triggers
  // Chrome's standard mic prompt, which appears next to the page's URL bar
  // (the "site information" button area) — no separate window opens.
  // The iframe posts a message back here on grant/denial.
  let micFrameTimeout = null;

  function showMicFrame() {
    panel.classList.remove('hidden');
    positionPanel();
    if (!micFrame.src) {
      // `embed=1` switches permissions.js into postMessage-on-result mode.
      micFrame.src = chrome.runtime.getURL('permissions.html?embed=1');
    }
    micFrame.classList.remove('hidden');
    statusEl.textContent = 'Grant microphone access in the prompt that appears next to the URL bar.';
    // If the iframe never reports back (page CSP blocks it, etc.), drop it
    // after a long timeout so the user can retry. The status text remains
    // actionable — they can click the BugScribe icon as a fallback path.
    clearTimeout(micFrameTimeout);
    micFrameTimeout = setTimeout(() => {
      hideMicFrame();
    }, 120000);
  }

  function hideMicFrame() {
    clearTimeout(micFrameTimeout);
    micFrameTimeout = null;
    micFrame.classList.add('hidden');
    // Clear src so a subsequent request starts fresh (and re-runs the prompt).
    micFrame.removeAttribute('src');
  }

  window.addEventListener('message', (e) => {
    // Only trust messages from our own extension iframe.
    const data = e.data;
    if (!data || data.source !== 'bugscribe-permissions') return;
    if (data.type === 'mic-granted') {
      hideMicFrame();
      statusEl.textContent = 'Microphone access granted — click Start to record.';
    } else if (data.type === 'mic-denied') {
      hideMicFrame();
      statusEl.textContent = 'Error: Microphone access denied. Allow it in the site/extension settings and try again.';
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'state-changed') { refresh(); return false; }
    if (msg.type === 'open-bug-modal') {
      // The toolbar popup forwards a click here so the modal opens on the
      // active page (the modal lives in this content script's shadow root).
      panel.classList.remove('hidden');
      positionPanel();
      openModal();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'request-mic-permission') {
      // Background asked us to surface the mic-permission iframe. Ack so the
      // background skips its fallback window — once we ack, the user
      // experience is inline-in-the-page.
      showMicFrame();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  // Live-refresh as the background writes recording state to session storage.
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'session') refresh();
    });
  }

  refresh();
})();

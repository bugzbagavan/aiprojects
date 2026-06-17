// Shared Azure DevOps REST helpers.
//
// Imported by content.js (lists dropdown values, creates the work item) and
// by offscreen.js (uploads the MP4 attachment + links it to the work item).
// The MP4 Blob only exists inside the offscreen document, which is why the
// flow is split across two contexts.
//
// Auth is always Personal Access Token via Basic: "Authorization: Basic
// base64(':' + PAT)". Credentials are injected by webpack.DefinePlugin so no
// secret ever lands in source.

const API_VERSION = '7.1';

export function hasAzureConfig(cfg) {
  return !!(cfg && cfg.pat && cfg.org && cfg.project);
}

export function readAzureConfigFromEnv() {
  return {
    pat: (process.env.AZURE_PAT || '').trim(),
    org: (process.env.AZURE_ORG_URL || '').replace(/\/+$/, ''),
    project: (process.env.AZURE_PROJECT || '').trim()
  };
}

function authHeader(pat) {
  return 'Basic ' + btoa(':' + pat);
}

async function readError(r) {
  // Azure responds with a JSON envelope on error — surface its `message`
  // when possible, otherwise fall back to the raw body so the user can see
  // why the call failed.
  const text = await r.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return j.message || j.value?.Message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function getJson(url, pat) {
  const r = await fetch(url, {
    headers: { Authorization: authHeader(pat), Accept: 'application/json' }
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${await readError(r)}`);
  return r.json();
}

// ---- Team members --------------------------------------------------------

export async function listTeamMembers({ org, project, pat }) {
  // Use the project's default team. Azure exposes it on the project record.
  const proj = await getJson(
    `${org}/_apis/projects/${encodeURIComponent(project)}?includeCapabilities=false&api-version=${API_VERSION}`,
    pat
  );
  const teamId = proj.defaultTeam?.id;
  if (!teamId) throw new Error('Project has no default team');
  const data = await getJson(
    `${org}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(teamId)}/members?api-version=${API_VERSION}`,
    pat
  );
  return (data.value || [])
    .map(m => ({
      displayName: m.identity?.displayName || '',
      uniqueName: m.identity?.uniqueName || ''
    }))
    .filter(m => m.displayName)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ---- Area / Iteration paths ---------------------------------------------

function flatten(node, parent) {
  // Azure returns a nested tree where the root node's name equals the project
  // and child paths are joined with backslashes — `\Project\Area\Sub`.
  const me = parent ? `${parent}\\${node.name}` : node.name;
  const out = [me];
  if (Array.isArray(node.children)) {
    for (const c of node.children) out.push(...flatten(c, me));
  }
  return out;
}

export async function listAreaPaths({ org, project, pat }) {
  const data = await getJson(
    `${org}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/Areas?$depth=10&api-version=${API_VERSION}`,
    pat
  );
  return flatten(data, '');
}

export async function listIterationPaths({ org, project, pat }) {
  const data = await getJson(
    `${org}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/Iterations?$depth=10&api-version=${API_VERSION}`,
    pat
  );
  return flatten(data, '');
}

// ---- Field discovery -----------------------------------------------------

export async function listFieldsForType({ org, project, pat, workItemType }) {
  // Returns the full field catalog for a work item type. Used to detect
  // which fields exist (so we don't submit Severity into a Suggestion that
  // doesn't have it) and to resolve display name → referenceName.
  const data = await getJson(
    `${org}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/fields?api-version=${API_VERSION}`,
    pat
  );
  return data.value || [];
}

export function findFieldByDisplayName(fields, displayName) {
  // Custom fields in inherited processes get reference names like
  // `Custom.BugCategory` while the form shows the friendly display name.
  // We accept either spelling so localized or renamed fields still resolve.
  const target = displayName.toLowerCase().trim();
  return fields.find(f =>
    (f.name || '').toLowerCase().trim() === target ||
    (f.referenceName || '').toLowerCase().endsWith('.' + target.replace(/\s+/g, ''))
  ) || null;
}

export async function discoverFieldRefName({ org, project, pat, workItemType, displayName }) {
  // Convenience wrapper kept for back-compat with the existing call site.
  const fields = await listFieldsForType({ org, project, pat, workItemType });
  return findFieldByDisplayName(fields, displayName)?.referenceName || null;
}

// ---- Work item lookup ---------------------------------------------------

export async function getWorkItem({ org, project, pat, workItemId }) {
  // Used to validate a parent-link ID and show the resolved title inline so
  // the user knows they typed the right number before submitting.
  return getJson(
    `${org}/${encodeURIComponent(project)}/_apis/wit/workitems/${encodeURIComponent(workItemId)}?fields=System.Id,System.Title,System.WorkItemType,System.State&api-version=${API_VERSION}`,
    pat
  );
}

// ---- Work item create + attachment --------------------------------------

export function parentLinkRelation({ org, parentId }) {
  // Hierarchy-Reverse points from a child up to its parent. Azure resolves
  // the work item from the URL regardless of project, so we build it from
  // the org root rather than the project path.
  return {
    rel: 'System.LinkTypes.Hierarchy-Reverse',
    url: `${org}/_apis/wit/workItems/${encodeURIComponent(parentId)}`,
    attributes: { comment: '' }
  };
}

export async function createWorkItem({ org, project, pat, workItemType, fields, relations }) {
  // POST /_apis/wit/workitems/${workItemType}. The leading `$` URL segment
  // is part of the Azure routing convention; the type itself must be
  // encoded so types with spaces ("Product Backlog Item") still resolve.
  const ops = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([refName, value]) => ({ op: 'add', path: `/fields/${refName}`, value }));

  // Optional relations (e.g. parent link) are applied atomically in the same
  // request so a create + link never leaves a parent-less orphan on failure.
  if (Array.isArray(relations)) {
    for (const rel of relations) {
      if (rel) ops.push({ op: 'add', path: '/relations/-', value: rel });
    }
  }

  const r = await fetch(
    `${org}/${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader(pat),
        'Content-Type': 'application/json-patch+json',
        Accept: 'application/json'
      },
      body: JSON.stringify(ops)
    }
  );
  if (!r.ok) throw new Error(`Create ${workItemType} failed: ${r.status} — ${await readError(r)}`);
  return r.json();
}

export async function uploadAttachment({ org, project, pat, blob, filename }) {
  const r = await fetch(
    `${org}/${encodeURIComponent(project)}/_apis/wit/attachments?fileName=${encodeURIComponent(filename)}&api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader(pat),
        'Content-Type': 'application/octet-stream'
      },
      body: blob
    }
  );
  if (!r.ok) throw new Error(`Attachment upload failed: ${r.status} — ${await readError(r)}`);
  return r.json(); // { id, url }
}

export async function linkAttachment({ org, project, pat, workItemId, attachmentUrl, filename }) {
  // Two-step attachment is required: upload returns a URL, then we PATCH the
  // work item to attach a relation of type "AttachedFile" pointing at it.
  const ops = [{
    op: 'add',
    path: '/relations/-',
    value: {
      rel: 'AttachedFile',
      url: attachmentUrl,
      attributes: { comment: filename }
    }
  }];
  const r = await fetch(
    `${org}/${encodeURIComponent(project)}/_apis/wit/workitems/${workItemId}?api-version=${API_VERSION}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: authHeader(pat),
        'Content-Type': 'application/json-patch+json',
        Accept: 'application/json'
      },
      body: JSON.stringify(ops)
    }
  );
  if (!r.ok) throw new Error(`Link attachment failed: ${r.status} — ${await readError(r)}`);
  return r.json();
}

export function workItemUrl({ org, project, workItemId }) {
  return `${org}/${encodeURIComponent(project)}/_workitems/edit/${workItemId}`;
}

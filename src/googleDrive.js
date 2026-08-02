// Thin wrapper around Google Identity Services + Drive API v3 + Picker,
// scoped to drive.file so the app can only touch files it created or
// files the teacher explicitly picks.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;
const SCOPE = "https://www.googleapis.com/auth/drive.file";

let gisLoaded = null;
let gapiLoaded = null;
let tokenClient = null;
let accessToken = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      if (existing.dataset.loaded === "true") resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function ensureConfigured() {
  if (!CLIENT_ID || !API_KEY) {
    throw new Error(
      "Google Drive isn't configured — set VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY in .env"
    );
  }
}

async function ensureGis() {
  if (!gisLoaded) {
    gisLoaded = loadScript("https://accounts.google.com/gsi/client");
  }
  await gisLoaded;
}

async function ensureGapiPicker() {
  if (!gapiLoaded) {
    gapiLoaded = loadScript("https://apis.google.com/js/api.js").then(
      () => new Promise((resolve) => window.gapi.load("picker", resolve))
    );
  }
  await gapiLoaded;
}

// Resolves with a valid access token, prompting a Google sign-in
// popup only when we don't already hold one.
export function getAccessToken() {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    ensureGis()
      .then(() => {
        if (!tokenClient) {
          tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPE,
            callback: () => {}, // overridden per-request below
          });
        }
        tokenClient.callback = (resp) => {
          if (resp.error) {
            reject(new Error(resp.error));
            return;
          }
          accessToken = resp.access_token;
          resolve(accessToken);
        };
        tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
      })
      .catch(reject);
  });
}

function driveFetch(path, options = {}) {
  return fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
}

// Surfaces Google's actual error message (e.g. "File not found: ...",
// "Insufficient permission") instead of just an HTTP status code, so a
// failure is diagnosable from the toast alone rather than guesswork.
async function throwIfNotOk(res, action) {
  if (res.ok) return;
  let detail = "";
  try {
    const body = await res.json();
    if (body?.error?.message) detail = ` — ${body.error.message}`;
  } catch {
    // response body wasn't JSON; fall back to just the status
  }
  throw new Error(`${action} failed (${res.status})${detail}`);
}

async function findFileIdByName(name) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const res = await driveFetch(`files?q=${q}&spaces=drive&fields=files(id,name)`);
  await throwIfNotOk(res, "Drive search");
  const json = await res.json();
  return json.files?.[0]?.id ?? null;
}

// Creates the file on first save, updates it in place on later saves, so
// repeated saves don't pile up duplicate files. `contentType` describes
// the bytes being uploaded; `targetMimeType` (defaults to the same) is
// what Drive stores the file as — passing a Google-native type here
// (e.g. a Sheet) while uploading plain CSV bytes is exactly the signal
// Drive uses to auto-convert the upload into that native format.
async function saveTextToDrive(filename, content, contentType, targetMimeType = contentType) {
  await getAccessToken();
  const existingId = await findFileIdByName(filename);
  const boundary = "teacher_connect_boundary";
  const metadata = existingId ? { name: filename } : { name: filename, mimeType: targetMimeType };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  await throwIfNotOk(res, "Drive save");
  return res.json();
}

// Turns on wrap-text for every cell so long IEP/behavior-note content
// is readable without the teacher manually resizing rows — Sheets
// defaults to clipping/overflowing text instead. Looks up the actual
// sheet ID rather than assuming 0, since that's not guaranteed.
async function applyWrapFormatting(spreadsheetId) {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.sheetId`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  await throwIfNotOk(metaRes, "Sheet lookup");
  const meta = await metaRes.json();
  const sheetId = meta.sheets?.[0]?.properties?.sheetId ?? 0;

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
            fields: "userEnteredFormat.wrapStrategy",
          },
        },
      ],
    }),
  });
  await throwIfNotOk(res, "Sheet formatting");
}

// Exports the roster as a real Google Sheet (not a plain CSV file) so
// formatting persists — Drive auto-converts CSV bytes into a native
// Sheet when the target mimeType is the Sheets type. Requires the
// Google Sheets API to be enabled on the same Cloud project as Drive.
export async function exportRosterSheetToDrive(filename, csvText) {
  const file = await saveTextToDrive(filename, csvText, "text/csv", "application/vnd.google-apps.spreadsheet");
  await applyWrapFormatting(file.id);
  return file;
}

// Opens Google's file picker and resolves with the picked doc's
// { id, name, mimeType }, or null if the teacher cancels. Includes both
// "My Drive" and "Shared with me" tabs — a plain DocsView only browses
// My Drive, so files someone else shared with the teacher wouldn't
// otherwise show up.
//
// Deliberately does NOT filter by mimeType here: Picker's per-folder
// listing can come back empty when a mimeType filter is combined with
// folder navigation (a file that's clearly there stops showing up once
// you open its folder), so instead every file type is shown and the
// caller validates the mimeType after the teacher picks something.
async function pickDriveFile() {
  const token = await getAccessToken();
  await ensureGapiPicker();

  return new Promise((resolve) => {
    const myDriveView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setLabel("My Drive");
    const sharedWithMeView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setOwnedByMe(false)
      .setLabel("Shared with me");
    const picker = new window.google.picker.PickerBuilder()
      .addView(myDriveView)
      .addView(sharedWithMeView)
      .enableFeature(window.google.picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) {
          resolve(data.docs[0]);
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Native Google Workspace files have no raw bytes to download — they must
// be exported to a plain format first.
const GOOGLE_NATIVE_EXPORT_MIME = {
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.document": "text/plain",
};

const ROSTER_MIME_TYPES = new Set([
  "text/csv",
  "text/plain",
  "application/pdf",
  ...Object.keys(GOOGLE_NATIVE_EXPORT_MIME),
]);

// Lets the teacher browse their Drive and pick a roster file (a Sheet,
// Doc, CSV, plain text list, or PDF), returning { name, mimeType,
// arrayBuffer }, or null if they cancel. Caller decides how to decode
// the bytes (plain text vs. PDF extraction) based on mimeType.
export async function pickRosterFileFromDrive() {
  ensureConfigured();
  const file = await pickDriveFile();
  if (!file) return null;
  if (!ROSTER_MIME_TYPES.has(file.mimeType)) {
    throw new Error(`"${file.name}" isn't a supported roster file — pick a Sheet, Doc, CSV, text, or PDF file.`);
  }

  const exportMime = GOOGLE_NATIVE_EXPORT_MIME[file.mimeType];
  const res = await driveFetch(
    exportMime ? `files/${file.id}/export?mimeType=${exportMime}` : `files/${file.id}?alt=media`
  );
  await throwIfNotOk(res, "Drive download");
  return {
    name: file.name,
    mimeType: exportMime || file.mimeType,
    arrayBuffer: await res.arrayBuffer(),
  };
}

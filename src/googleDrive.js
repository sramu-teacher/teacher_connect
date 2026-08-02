// Thin wrapper around Google Identity Services + Drive API v3 + Picker,
// scoped to drive.file so the app can only touch files it created or
// files the teacher explicitly picks.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;
const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID;
// email/profile let us identify the signed-in teacher (for the account
// system) without needing a separate ID-token sign-in flow — the same
// access token used for Drive calls can also read the user's profile.
const SCOPE = "https://www.googleapis.com/auth/drive.file email profile";

let gisLoaded = null;
let gapiLoaded = null;
let tokenClient = null;
let accessToken = null;
let pendingTokenRequest = null;

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
  if (!CLIENT_ID || !API_KEY || !APP_ID) {
    throw new Error(
      "Google Drive isn't configured — set VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY, and VITE_GOOGLE_APP_ID in .env"
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

// Requests a token with the given prompt mode, de-duping concurrent
// callers onto a single in-flight request — without this, two things
// asking for a token in the same tick (e.g. the sign-in click and the
// Drive-sync effect that fires right after) could each decide "no
// token yet" and independently pop an interactive consent screen.
function requestToken(promptMode) {
  if (pendingTokenRequest) return pendingTokenRequest;
  pendingTokenRequest = new Promise((resolve, reject) => {
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
          pendingTokenRequest = null;
          if (resp.error) {
            reject(new Error(resp.error));
            return;
          }
          accessToken = resp.access_token;
          resolve(accessToken);
        };
        tokenClient.requestAccessToken({ prompt: promptMode });
      })
      .catch((err) => {
        pendingTokenRequest = null;
        reject(err);
      });
  });
  return pendingTokenRequest;
}

// Resolves with a valid access token. Reuses one already held; only
// asks Google for a new one *silently* (no visible prompt) otherwise —
// this only succeeds if the browser still has an active Google session
// with prior consent for these scopes. Callers that need to show the
// interactive consent screen (the Sign In button) should call
// requestInteractiveSignIn() instead.
export function getAccessToken() {
  ensureConfigured();
  if (accessToken) return Promise.resolve(accessToken);
  return requestToken("");
}

// Always shows Google's interactive consent screen — used only by the
// explicit "Sign in with Google" button, including as a fallback when
// a silent re-auth attempt (getAccessToken) fails.
export function requestInteractiveSignIn() {
  ensureConfigured();
  accessToken = null;
  return requestToken("consent");
}

// Fetches the signed-in teacher's Google profile (email, name, avatar)
// using the same access token already granted for Drive access — this
// is what "who's logged in" is based on, no separate identity API.
export async function getUserProfile() {
  const token = await getAccessToken();
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Couldn't fetch profile (${res.status})`);
  const data = await res.json();
  return { email: data.email, name: data.name, picture: data.picture };
}

// Ends the session: revokes the access token so a future sign-in
// requires fresh consent rather than silently reusing this one.
export function signOut() {
  return new Promise((resolve) => {
    pendingTokenRequest = null;
    if (!accessToken || !window.google?.accounts?.oauth2) {
      accessToken = null;
      tokenClient = null;
      resolve();
      return;
    }
    window.google.accounts.oauth2.revoke(accessToken, () => {
      accessToken = null;
      tokenClient = null;
      resolve();
    });
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

const APP_STATE_FILENAME = "teacher_connect-app-state.json";

// Full-fidelity auto-sync used by the sign-in flow: every period's
// roster, room layout, seat assignments, and notes, saved to a fixed
// file in the signed-in teacher's own Drive so it follows them across
// devices. Distinct from exportRosterSheetToDrive (a human-readable
// Sheet meant for sharing/reviewing, not for round-tripping state).
export function saveAppStateToDrive(dataObj) {
  return saveTextToDrive(APP_STATE_FILENAME, JSON.stringify(dataObj), "application/json");
}

export async function loadAppStateFromDrive() {
  await getAccessToken();
  const id = await findFileIdByName(APP_STATE_FILENAME);
  if (!id) return null;
  const res = await driveFetch(`files/${id}?alt=media`);
  await throwIfNotOk(res, "Drive state load");
  return res.json();
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
      .setAppId(APP_ID)
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

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

async function findFileIdByName(name) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const res = await driveFetch(`files?q=${q}&spaces=drive&fields=files(id,name)`);
  if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
  const json = await res.json();
  return json.files?.[0]?.id ?? null;
}

// Creates the file on first save, updates it in place on later saves,
// so repeated "Save to Drive" clicks don't pile up duplicate files.
export async function saveJsonToDrive(filename, dataObj) {
  await getAccessToken();
  const existingId = await findFileIdByName(filename);
  const boundary = "teacher_connect_boundary";
  const metadata = existingId
    ? { name: filename }
    : { name: filename, mimeType: "application/json" };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(dataObj, null, 2)}\r\n` +
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
  if (!res.ok) throw new Error(`Drive save failed (${res.status})`);
  return res.json();
}

// Opens Google's file picker (scoped to the teacher's Drive) so they can
// choose a JSON export to load, then returns the parsed file contents.
export async function loadJsonFromDrive() {
  ensureConfigured();
  const token = await getAccessToken();
  await ensureGapiPicker();

  const fileId = await new Promise((resolve, reject) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes("application/json")
      .setIncludeFolders(true);
    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) {
          resolve(data.docs[0].id);
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });

  if (!fileId) return null;

  const res = await driveFetch(`files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  return res.json();
}

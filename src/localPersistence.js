// Keeps the whole app state (all periods, room layouts, seating charts)
// sticky across refreshes on this one browser/device. This is a fast
// local cache, not the source of truth — Drive (per signed-in teacher)
// is; see App.jsx / teacher_connect.jsx for how the two are combined.
//
// LEGACY_STORAGE_KEY is the single, unkeyed key used before accounts
// existed — kept around so a teacher's pre-account data can be found
// and migrated into her signed-in profile on first sign-in, instead of
// being stranded behind the new sign-in wall.
export const LEGACY_STORAGE_KEY = "teacher_connect_state_v1";

export function userStorageKey(email) {
  return `teacher_connect_state_v1__${email}`;
}

export function loadPersistedState(key = LEGACY_STORAGE_KEY) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function savePersistedState(state, key = LEGACY_STORAGE_KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false; // e.g. private browsing, storage quota exceeded
  }
}

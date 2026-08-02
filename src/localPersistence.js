// Keeps the whole app state (all periods, room layouts, seating charts)
// sticky across refreshes on this one browser/device. This is NOT a
// backup — it's local-only and disappears if the browser's site data is
// cleared or the teacher switches devices; Drive/file export remains the
// way to move or durably back up a roster.
const STORAGE_KEY = "teacher_connect_state_v1";

export function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function savePersistedState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false; // e.g. private browsing, storage quota exceeded
  }
}

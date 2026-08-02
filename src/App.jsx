import { useState, useEffect } from "react";
import SignIn from "./SignIn.jsx";
import SeatingChart from "./teacher_connect.jsx";
import { getUserProfile, requestInteractiveSignIn, signOut as driveSignOut } from "./googleDrive";

// Just a hint to attempt a silent re-auth on load — not itself a
// credential, so it's fine to keep in plain localStorage.
const LAST_SIGNED_IN_KEY = "teacher_connect_had_session";

// Gates the whole app behind Google sign-in — this is how the app
// knows which teacher it's talking to, and by extension whose Drive
// to read/write roster data from. There's no separate registration
// step: signing in with Google for the first time *is* creating a
// profile, since there's nothing else to collect.
export default function App() {
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  // On load, if this browser was signed in before, try to resume
  // silently (no visible prompt) rather than forcing a fresh consent
  // click on every page refresh. Only succeeds if the browser still has
  // an active Google session with prior consent for our scopes — if
  // not, this just fails quietly and falls back to the sign-in screen.
  useEffect(() => {
    if (localStorage.getItem(LAST_SIGNED_IN_KEY) !== "1") {
      setCheckingSession(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const profile = await getUserProfile();
        if (!cancelled) setUser(profile);
      } catch {
        // silent resume failed (session expired, consent revoked
        // elsewhere, etc.) — fall back to showing the sign-in button
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignIn = async () => {
    setError(null);
    try {
      await requestInteractiveSignIn();
      const profile = await getUserProfile();
      localStorage.setItem(LAST_SIGNED_IN_KEY, "1");
      setUser(profile);
    } catch (err) {
      setError(err.message || "Couldn't sign in with Google — please try again.");
    }
  };

  const handleSignOut = async () => {
    await driveSignOut();
    localStorage.removeItem(LAST_SIGNED_IN_KEY);
    setUser(null);
  };

  if (checkingSession) {
    return <div style={{ minHeight: "100vh", background: "#FAF7F0" }} />;
  }

  if (!user) {
    return <SignIn onSignIn={handleSignIn} error={error} />;
  }

  return <SeatingChart user={user} onSignOut={handleSignOut} />;
}

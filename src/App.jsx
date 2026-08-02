import { useState } from "react";
import SignIn from "./SignIn.jsx";
import SeatingChart from "./teacher_connect.jsx";
import { getUserProfile, signOut as driveSignOut } from "./googleDrive";

// Gates the whole app behind Google sign-in — this is how the app
// knows which teacher it's talking to, and by extension whose Drive
// to read/write roster data from. There's no separate registration
// step: signing in with Google for the first time *is* creating a
// profile, since there's nothing else to collect.
export default function App() {
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);

  const handleSignIn = async () => {
    setError(null);
    try {
      const profile = await getUserProfile();
      setUser(profile);
    } catch (err) {
      setError(err.message || "Couldn't sign in with Google — please try again.");
    }
  };

  const handleSignOut = async () => {
    await driveSignOut();
    setUser(null);
  };

  if (!user) {
    return <SignIn onSignIn={handleSignIn} error={error} />;
  }

  return <SeatingChart user={user} onSignOut={handleSignOut} />;
}

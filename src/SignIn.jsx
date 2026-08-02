import { useState } from "react";
import { LogIn, Loader2 } from "lucide-react";

// Matches teacher_connect.jsx's design tokens; duplicated here (rather
// than importing from that file) to keep this small standalone screen
// independent of the main app component.
const T = {
  ink: "#1F2A24",
  paper: "#FAF7F0",
  paperDim: "#F1ECE0",
  line: "#D9D2C0",
  brass: "#B8862F",
  graphite: "#3D3D3D",
};

export default function SignIn({ onSignIn, error }) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      await onSignIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: T.paper,
        fontFamily: "'Iowan Old Style','Georgia',serif",
        color: T.ink,
        padding: 24,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap');
        .signin-serif { font-family: 'Fraunces', Georgia, serif; }
        .signin-sans { font-family: 'Inter', system-ui, sans-serif; }
        .spin { animation: signin-spin 0.8s linear infinite; }
        @keyframes signin-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          border: `1px solid ${T.line}`,
          borderRadius: 14,
          background: T.paper,
          padding: "36px 32px",
          textAlign: "center",
          boxShadow: "0 12px 32px rgba(0,0,0,0.06)",
        }}
      >
        <div
          className="signin-sans"
          style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: T.brass, fontWeight: 600, marginBottom: 6 }}
        >
          Roster &amp; Room
        </div>
        <h1 className="signin-serif" style={{ margin: "0 0 10px", fontSize: 26, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Seating Intelligence
        </h1>
        <p className="signin-sans" style={{ fontSize: 13.5, color: "#8A8272", marginBottom: 28, lineHeight: 1.5 }}>
          Sign in with your Google account to create your teacher profile.
          Your rosters, seating charts, and notes are saved to your own
          Google Drive and follow you to any device you sign in on.
        </p>

        <button
          onClick={handleClick}
          disabled={busy}
          className="signin-sans"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            width: "100%",
            background: T.ink,
            border: "none",
            borderRadius: 8,
            padding: "13px 18px",
            fontSize: 14.5,
            fontWeight: 700,
            color: T.paper,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? <Loader2 size={17} className="spin" /> : <LogIn size={17} />}
          {busy ? "Signing in…" : "Sign in with Google"}
        </button>

        {error && (
          <div
            className="signin-sans"
            style={{ marginTop: 16, fontSize: 12.5, color: "#A6452F", background: "#F2DDD5", borderRadius: 8, padding: "10px 12px", textAlign: "left" }}
          >
            {error}
          </div>
        )}

        <div className="signin-sans" style={{ marginTop: 22, fontSize: 11, color: "#A89F8C", lineHeight: 1.5 }}>
          First time here? Signing in creates your profile automatically —
          nothing else to register.
        </div>
      </div>
    </div>
  );
}

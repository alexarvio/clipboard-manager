import { useState } from "react";
import { invoke } from "../lib/tauriShim";
import fatClipboardLogo from "../assets/fatclipboard-wordmark.png";

// Mirrors src-tauri/src/settings.rs::Settings closely enough for what this
// screen needs back -- auth_signup/auth_login return the *whole* updated
// Settings object (see main.rs) so the caller can drop straight into the
// signed-in app without a second get_settings round-trip.
interface AuthSettings {
  auth_token: string;
  user_email: string;
  first_name: string;
  tier: "free" | "pro";
  theme: "dark" | "light";
  onboarding_complete: boolean;
  [key: string]: unknown;
}

// Required before first use (see main.rs's needs_auth check in setup(), which
// surfaces this panel immediately on a fresh install rather than waiting for
// the hotkey) -- App.tsx and Dashboard.tsx both render nothing else until
// settings.auth_token is non-empty.
type Mode = "signup" | "login" | "forgot" | "reset";

export default function AuthGate({ onAuthenticated }: { onAuthenticated: (settings: AuthSettings) => void }) {
  const [mode, setMode] = useState<Mode>("signup");
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once /auth/forgot-password succeeds, shown at the top of the
  // "reset" screen so it's clear a code is (probably) on its way.
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (mode === "signup" && !firstName.trim()) {
      setError("Enter your first name.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const settings = await invoke<AuthSettings>(
        mode === "signup" ? "auth_signup" : "auth_login",
        mode === "signup"
          ? { email: email.trim(), password, firstName: firstName.trim() }
          : { email: email.trim(), password }
      );
      onAuthenticated(settings);
    } catch (err) {
      setError(typeof err === "string" ? err : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }

    setLoading(true);
    try {
      const message = await invoke<string>("request_password_reset", { email: email.trim() });
      setForgotMessage(message);
      switchMode("reset");
    } catch (err) {
      setError(typeof err === "string" ? err : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (!resetToken.trim()) {
      setError("Paste the code from your email.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const settings = await invoke<AuthSettings>("reset_password", {
        token: resetToken.trim(),
        newPassword,
      });
      onAuthenticated(settings);
    } catch (err) {
      setError(typeof err === "string" ? err : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const isAccountMode = mode === "signup" || mode === "login";

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-ink dark:text-cream">
      <img src={fatClipboardLogo} alt="FatClipboard" className="h-7 w-auto mb-4" />
      <h1 className="text-[17px] font-semibold mb-1">
        {mode === "forgot" ? "Reset your password" : mode === "reset" ? "Check your email" : "Welcome to FatClipboard"}
      </h1>
      <p className="text-[12.5px] text-inkMuted dark:text-inkMutedDark text-center mb-6 max-w-[260px]">
        {mode === "signup" && "Create an account to get started."}
        {mode === "login" && "Log in to your FatClipboard account."}
        {mode === "forgot" && "Enter your email and we'll send you a code to reset your password."}
        {mode === "reset" &&
          (forgotMessage ?? "Paste the code from your email, then choose a new password.")}
      </p>

      {isAccountMode && (
        <div className="flex w-full max-w-[280px] bg-black/[0.05] dark:bg-white/[0.07] rounded-full p-1 mb-5 text-[12.5px] font-medium">
          <button
            type="button"
            onClick={() => switchMode("signup")}
            className={`flex-1 py-1.5 rounded-full transition-colors ${
              mode === "signup"
                ? "bg-white dark:bg-charcoalSurface shadow-sm"
                : "text-inkMuted dark:text-inkMutedDark"
            }`}
          >
            Sign up
          </button>
          <button
            type="button"
            onClick={() => switchMode("login")}
            className={`flex-1 py-1.5 rounded-full transition-colors ${
              mode === "login"
                ? "bg-white dark:bg-charcoalSurface shadow-sm"
                : "text-inkMuted dark:text-inkMutedDark"
            }`}
          >
            Log in
          </button>
        </div>
      )}

      {isAccountMode && (
        <form onSubmit={submit} className="w-full max-w-[280px] space-y-2.5">
          {mode === "signup" && (
            <input
              type="text"
              autoFocus
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              autoComplete="given-name"
              maxLength={50}
              className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2.5 text-[13px] outline-none"
            />
          )}
          <input
            type="email"
            autoFocus={mode !== "signup"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2.5 text-[13px] outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "Password (min. 8 characters)" : "Password"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2.5 text-[13px] outline-none"
          />

          {error && <p className="text-[12px] text-red-500 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium disabled:opacity-50"
          >
            {loading ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>

          {mode === "login" && (
            <button
              type="button"
              onClick={() => switchMode("forgot")}
              className="w-full text-center text-[12px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream pt-1"
            >
              Forgot password?
            </button>
          )}
        </form>
      )}

      {mode === "forgot" && (
        <form onSubmit={submitForgot} className="w-full max-w-[280px] space-y-2.5">
          <input
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2.5 text-[13px] outline-none"
          />

          {error && <p className="text-[12px] text-red-500 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium disabled:opacity-50"
          >
            {loading ? "Please wait…" : "Send reset code"}
          </button>

          <button
            type="button"
            onClick={() => switchMode("login")}
            className="w-full text-center text-[12px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream pt-1"
          >
            Back to log in
          </button>
        </form>
      )}

      {mode === "reset" && (
        <form onSubmit={submitReset} className="w-full max-w-[280px] space-y-2.5">
          <input
            type="text"
            autoFocus
            value={resetToken}
            onChange={(e) => setResetToken(e.target.value)}
            placeholder="Reset code from your email"
            autoComplete="one-time-code"
            className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2.5 text-[13px] outline-none"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password (min. 8 characters)"
            autoComplete="new-password"
            className="w-full bg-black/[0.04] dark:bg-white/[0.06] border border-borderLight dark:border-borderDark rounded-lg px-3 py-2.5 text-[13px] outline-none"
          />

          {error && <p className="text-[12px] text-red-500 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-ink dark:bg-cream text-cream dark:text-charcoal rounded-lg py-2.5 text-[12.5px] font-medium disabled:opacity-50"
          >
            {loading ? "Please wait…" : "Reset password"}
          </button>

          <button
            type="button"
            onClick={() => switchMode("login")}
            className="w-full text-center text-[12px] text-inkMuted dark:text-inkMutedDark hover:text-ink dark:hover:text-cream pt-1"
          >
            Back to log in
          </button>
        </form>
      )}

      {isAccountMode && (
        <p className="text-[11px] text-inkMuted dark:text-inkMutedDark mt-6 max-w-[260px] text-center">
          Free forever for core features. No spam, no card required to start.
        </p>
      )}
    </div>
  );
}

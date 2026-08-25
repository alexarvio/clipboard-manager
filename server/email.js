// Sends Clip's transactional emails via Resend (https://resend.com) --
// picked over rolling raw SMTP because it's just one API call per email and
// has a generous free tier for this volume. Kept in its own module so the
// template HTML doesn't clutter index.js, and so a missing/misconfigured
// RESEND_API_KEY degrades gracefully (logs a warning, skips sending) rather
// than crashing anything -- a broken email integration should never be able
// to break sign-up itself.

const { Resend } = require("resend");

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
// Resend's own onboarding@resend.dev sender works with zero setup for
// testing, but can only send to the email address you signed up to Resend
// with. Once you've verified your own domain (see server/README.md), point
// this at something like "Clip <hello@clip.com>" instead.
const EMAIL_FROM = process.env.EMAIL_FROM || "Clip <onboarding@resend.dev>";

if (!RESEND_API_KEY) {
  console.warn(
    "[clip-server] WARNING: RESEND_API_KEY is not set. Welcome emails will be skipped."
  );
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function welcomeEmailHtml() {
  return `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto; color: #1A1816; line-height: 1.6;">
      <p style="font-size: 20px; margin: 0 0 16px;">Welcome to Clip 👋</p>
      <p>Thanks for creating an account. Clip remembers everything you copy, sorts it into folders, and can rewrite, summarize, or translate any snippet with AI.</p>
      <p style="margin-bottom: 8px;">A few things worth trying first:</p>
      <ul style="padding-left: 20px; margin: 0 0 16px;">
        <li>Hit <strong>Ctrl+Shift+V</strong> anywhere to open your clipboard history</li>
        <li>Pin your most-used snippets so they're always one click away</li>
        <li>Save recurring text -- templates, signatures, snippets -- into a folder</li>
      </ul>
      <p>Questions? Just reply to this email -- a real person reads these.</p>
      <p style="color: #6E6859; font-size: 13px; margin-top: 24px;">-- The Clip team</p>
    </div>
  `;
}

// Fire-and-forget from the caller's perspective -- this never throws (all
// failures are caught and logged internally), so sign-up always succeeds
// even if the email provider is down, misconfigured, or rate-limited.
async function sendWelcomeEmail(toEmail) {
  if (!resend) return;
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: toEmail,
      subject: "Welcome to Clip",
      html: welcomeEmailHtml(),
    });
  } catch (err) {
    console.error("[clip-server] failed to send welcome email:", err);
  }
}

function passwordResetEmailHtml(token) {
  return `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto; color: #1A1816; line-height: 1.6;">
      <p style="font-size: 20px; margin: 0 0 16px;">Reset your Clip password</p>
      <p>Someone (hopefully you) asked to reset the password on this account. Copy the code below and paste it into Clip's "Reset password" screen, along with your new password.</p>
      <p style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 15px; letter-spacing: 0.02em; background: #FFFFFF; border-radius: 8px; padding: 12px 16px; word-break: break-all;">${token}</span>
      </p>
      <p style="color: #6E6859; font-size: 13px;">This code expires in 1 hour and can only be used once. If you didn't request this, you can safely ignore this email -- your password hasn't changed.</p>
      <p style="color: #6E6859; font-size: 13px; margin-top: 24px;">-- The Clip team</p>
    </div>
  `;
}

// NOT fire-and-forget, unlike the welcome email -- this token is the only
// way the password reset flow completes, so the caller awaits and logs a
// failure here rather than it vanishing silently. The route itself still
// returns the same generic response either way (see index.js), so a failed
// send doesn't leak anything to the client, only to the server log.
async function sendPasswordResetEmail(toEmail, token) {
  if (!resend) {
    console.warn(
      "[clip-server] RESEND_API_KEY not set -- password reset email not sent. " +
        `For local testing, the reset code is: ${token}`
    );
    return;
  }
  await resend.emails.send({
    from: EMAIL_FROM,
    to: toEmail,
    subject: "Reset your Clip password",
    html: passwordResetEmailHtml(token),
  });
}

function verificationEmailHtml(code) {
  return `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto; color: #1A1816; line-height: 1.6;">
      <p style="font-size: 20px; margin: 0 0 16px;">Verify your email</p>
      <p>Paste this code into Clip to verify your email address. You need a verified email before starting a Pro trial.</p>
      <p style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 24px; letter-spacing: 0.12em; background: #FFFFFF; border-radius: 8px; padding: 12px 20px;">${code}</span>
      </p>
      <p style="color: #6E6859; font-size: 13px;">This code expires in 30 minutes and can only be used once. If you didn't create a Clip account, you can safely ignore this email.</p>
      <p style="color: #6E6859; font-size: 13px; margin-top: 24px;">-- The Clip team</p>
    </div>
  `;
}

// NOT fire-and-forget when called from /auth/resend-verification (an
// explicit user action -- a failure there should surface as an error
// rather than vanish), but IS fire-and-forget when called right after
// signup (same reasoning as sendWelcomeEmail: verifying isn't required to
// use the free tier, so a slow/down email provider should never be able to
// block account creation). The caller decides whether to await this.
async function sendVerificationEmail(toEmail, code) {
  if (!resend) {
    console.warn(
      "[clip-server] RESEND_API_KEY not set -- verification email not sent. " +
        `For local testing, the verification code is: ${code}`
    );
    return;
  }
  await resend.emails.send({
    from: EMAIL_FROM,
    to: toEmail,
    subject: "Verify your email for Clip",
    html: verificationEmailHtml(code),
  });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, sendVerificationEmail };

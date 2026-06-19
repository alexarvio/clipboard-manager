// Tiny proxy server for Clip's AI transform feature.
//
// Why this exists: the desktop app needs to call an LLM to transform clipboard
// text (fix grammar, summarize, translate, etc.), but it can never hold the
// real Anthropic API key itself -- anything shipped inside a desktop binary
// can be extracted. So instead, the app calls *this* server, this server
// holds the real key as an environment variable, and forwards the request.
//
// This is also the future home of real per-user gating (Stripe subscription
// check, usage limits, etc.) -- for now it just checks a single shared
// secret so random strangers on the internet can't run up your API bill the
// moment this is deployed somewhere public.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = process.env.PORT || 8787;
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "[clip-server] WARNING: ANTHROPIC_API_KEY is not set. /transform will fail until it is."
  );
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: "200kb" }));

// Simple shared-secret check. This is NOT real per-user auth -- it just
// confirms the request came from a build of the app that knows the secret,
// so this endpoint can't be hammered anonymously by anyone who finds the
// URL. Real per-user accounts/billing is a separate, later step.
function requireAppSecret(req, res, next) {
  if (!APP_SHARED_SECRET) return next(); // not configured -> auth disabled (local dev)
  const provided = req.header("x-app-secret");
  if (provided !== APP_SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/transform", requireAppSecret, async (req, res) => {
  const { content, instruction } = req.body || {};

  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  if (typeof instruction !== "string" || !instruction.trim()) {
    return res.status(400).json({ error: "instruction is required" });
  }
  // Guard against someone sending a huge payload through this endpoint --
  // clipboard transforms should be short, not entire documents.
  if (content.length > 20000) {
    return res.status(400).json({ error: "content too long" });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Apply this instruction to the text below. Return ONLY the transformed text, with no preamble, no explanation, and no quotation marks around it.\n\nInstruction: ${instruction}\n\nText:\n${content}`,
        },
      ],
    });

    const transformed = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    res.json({ result: transformed });
  } catch (err) {
    console.error("[clip-server] /transform failed:", err);
    res.status(502).json({ error: "transform failed" });
  }
});

app.listen(PORT, () => {
  console.log(`[clip-server] listening on http://localhost:${PORT}`);
});

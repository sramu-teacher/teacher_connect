// Cloudflare Worker: proxies "polish this text" requests to Claude's API.
//
// Why this exists at all: the frontend is a static site with no backend,
// but an Anthropic API key can never be shipped to the browser — anyone
// could pull it out of the page source and run up charges. This Worker
// holds the key as a server-side secret and is the only thing that talks
// to Claude directly. It also applies a basic per-IP daily cap, since the
// app is public and multi-tenant (every teacher who signs in can hit this).

const ALLOWED_ORIGIN = "https://sramu-teacher.github.io";
const DAILY_LIMIT_PER_IP = 30;
const MAX_INPUT_CHARS = 8000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function checkRateLimit(env, ip) {
  const key = `ratelimit:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= DAILY_LIMIT_PER_IP) return false;
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 });
  return true;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return json({ error: "Daily limit reached for this feature — please try again tomorrow." }, 429);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const text = (body?.text || "").trim();
    if (!text) return json({ error: "No text provided" }, 400);
    if (text.length > MAX_INPUT_CHARS) {
      return json({ error: `Text is too long to polish (max ${MAX_INPUT_CHARS} characters).` }, 400);
    }

    // effort: "low" — this is a short, well-scoped wording pass, not a
    // reasoning-heavy task, so the cheaper/faster tier is the right fit.
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1024,
        output_config: { effort: "low" },
        system:
          "You polish text a teacher wrote in notes about a student (behavior notes or IEP/504 accommodations). Improve clarity, grammar, and an objective, professional tone. Do not invent, add, or infer any new facts, claims, or details that are not already present in the original text. Do not add commentary, headers, or explanations. Respond with ONLY the polished text — no preamble, no quotation marks, no markdown formatting.",
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text().catch(() => "");
      return json({ error: `Claude API error (${anthropicRes.status})`, detail }, 502);
    }

    const data = await anthropicRes.json();

    // Opus 5 runs safety classifiers on every request; a decline is a
    // normal 200 response with stop_reason "refusal", not an HTTP error.
    if (data.stop_reason === "refusal") {
      return json({ error: "The text couldn't be polished — please edit it manually." }, 422);
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return json({ error: "No response text from Claude" }, 502);
    }

    return json({ polished: textBlock.text.trim() });
  },
};

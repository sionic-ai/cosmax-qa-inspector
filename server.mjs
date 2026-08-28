import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5173;
const API_URL = "https://apis.opengateway.ai/v1/chat/completions";
const API_KEY = process.env.OPENGATEWAY_API_KEY || "";
const DEFAULT_MODEL = "moonshotai/kimi-k3-ultrafast";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  // ─── Proxy: /api/inspect ────────────────────────────────────────────
  if (url.pathname === "/api/inspect" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" })); return;
    }
    const { image, model } = parsed;
    if (!image) {
      res.writeHead(400).end(JSON.stringify({ error: "Missing image field" })); return;
    }

    const payload = {
      model: model || DEFAULT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text:
`You are a high-speed cosmetic-line quality inspector for COSMAX.
Analyze the image and determine if the item shows a DEFECT.
Respond ONLY with a compact JSON object — no markdown, no explanation:
{"defect": boolean, "type": string, "confidence": number}
- defect: true if a visible defect exists, false if OK
- type: short defect label in English, or "OK" when none
- confidence: 0.00–1.00`
          },
          { type: "image_url", image_url: { url: image } },
        ],
      }],
      temperature: 0.2,
      max_tokens: 60,
    };

    const t0 = Date.now();
    try {
      const r = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      const latency = Date.now() - t0;

      if (!r.ok) {
        res.writeHead(r.status).end(JSON.stringify({ error: data }));
        return;
      }

      let raw = data.choices?.[0]?.message?.content ?? "";
      raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
      let result = {};
      try { result = JSON.parse(raw); } catch { result = { raw }; }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...result,
        model: model || DEFAULT_MODEL,
        latency_ms: latency,
        usage: data.usage,
      }));
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // ─── Static files ───────────────────────────────────────────────────
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const fp = path.join(__dirname, "public", p);
  try {
    const buf = await readFile(fp);
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => console.log(`COSMAX inspector ▸ http://localhost:${PORT}`));

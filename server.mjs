import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import os from "node:os";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".md":   "text/plain; charset=utf-8",
};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname === "/api/ollama/chat" && request.method === "POST") {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(body);

        if (process.env.GROQ_API_KEY) {
          // ── Modo cloud: traduz Ollama → Groq ──────────────────────
          const hasImages = parsed.messages.some(m => m.images?.length);
          const model = hasImages
            ? "meta-llama/llama-4-scout-17b-16e-instruct"
            : "llama-3.3-70b-versatile";

          const groqMessages = parsed.messages.map(msg => {
            if (msg.images?.length) {
              return {
                role: msg.role,
                content: [
                  ...(msg.content ? [{ type: "text", text: msg.content }] : []),
                  ...msg.images.map(img => ({
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${img}` },
                  })),
                ],
              };
            }
            return { role: msg.role, content: msg.content || "" };
          });

          const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({ model, messages: groqMessages }),
          });

          const groqData = await groqResp.json();
          if (!groqResp.ok) throw new Error(groqData.error?.message || `Groq erro ${groqResp.status}`);

          // Devolve no formato Ollama para o frontend não precisar mudar
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            model,
            message: { role: "assistant", content: groqData.choices?.[0]?.message?.content ?? "" },
            done: true,
          }));

        } else {
          // ── Modo local: repassa para Ollama ───────────────────────
          const ollamaResponse = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const text = await ollamaResponse.text();
          response.writeHead(ollamaResponse.status, { "Content-Type": "application/json; charset=utf-8" });
          response.end(text);
        }

      } catch (error) {
        response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: `IA indisponivel: ${error.message}` }));
      }
    });
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = normalize(join(root, relative));

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end("Arquivo nao encontrado");
    return;
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    response.writeHead(403);
    response.end("Acesso negado");
    return;
  }

  response.writeHead(200, {
    "Content-Type": types[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  const localIP = getLocalIP();
  console.log("");
  console.log("  Bravax Protege — servidor iniciado");
  console.log("");
  console.log(`  Local:    http://localhost:${port}`);
  if (localIP) {
    console.log(`  Rede:     http://${localIP}:${port}   ← compartilhe com a equipe`);
  }
  console.log("");
  console.log("  Qualquer dispositivo na mesma rede Wi-Fi/cabo pode acessar pelo link 'Rede'.");
  console.log("  Para encerrar: Ctrl + C");
  console.log("");
});

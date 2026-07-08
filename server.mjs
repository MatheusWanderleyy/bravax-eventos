import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

// ─── BANCO DE DADOS (arquivo JSON persistente) ─────────────────────
const DATA_DIR   = process.env.DATA_DIR || join(root, "data");
const DATA_FILE  = join(DATA_DIR, "dados.json");
const FOTOS_DIR  = join(DATA_DIR, "fotos");
const BACKUP_DIR = join(DATA_DIR, "backups");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(FOTOS_DIR, { recursive: true });
mkdirSync(BACKUP_DIR, { recursive: true });

let db = { operadores: [], sessions: {}, state: { fornecedores: [], eventos: [] }, rev: 0 };
try { db = { ...db, ...JSON.parse(readFileSync(DATA_FILE, "utf8")) }; } catch {}

function persistDb() {
  writeFileSync(DATA_FILE, JSON.stringify(db));
  // Backup diário automático — mantém os últimos 14 dias
  try {
    const hoje = new Date().toISOString().split("T")[0];
    const backupFile = join(BACKUP_DIR, `dados-${hoje}.json`);
    if (!existsSync(backupFile)) {
      writeFileSync(backupFile, JSON.stringify(db));
      const antigos = readdirSync(BACKUP_DIR).filter(f => f.startsWith("dados-")).sort();
      while (antigos.length > 14) unlinkSync(join(BACKUP_DIR, antigos.shift()));
    }
  } catch {}
}
function hashPin(pin, salt) { return crypto.createHash("sha256").update(salt + ":" + pin).digest("hex"); }

function getSession(request) {
  const token = (request.headers.authorization || "").replace("Bearer ", "");
  return db.sessions[token] ? { token, nome: db.sessions[token].nome } : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 10_000_000) request.destroy(); });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

async function handleApi(request, response, url) {
  const send = (status, obj) => { response.writeHead(status, JSON_HEADERS); response.end(JSON.stringify(obj)); };

  // Lista de operadores (público — usado na tela de login)
  if (url.pathname === "/api/operadores" && request.method === "GET") {
    return send(200, { operadores: db.operadores.map(o => o.nome), setup: db.operadores.length === 0 });
  }

  // Criar operador (primeiro é livre; depois exige login OU autorização de operador existente)
  if (url.pathname === "/api/operadores" && request.method === "POST") {
    const { nome, pin, autorizador } = JSON.parse(await readBody(request) || "{}");
    if (db.operadores.length > 0 && !getSession(request)) {
      const aut = autorizador && db.operadores.find(o => o.nome === autorizador.nome);
      if (!aut || hashPin(autorizador.pin || "", aut.salt) !== aut.hash) {
        return send(401, { error: "Autorização inválida — peça a um operador já cadastrado para digitar o PIN dele" });
      }
    }
    if (!nome?.trim() || !/^\d{4,6}$/.test(pin || "")) return send(400, { error: "Informe nome e PIN de 4 a 6 dígitos" });
    if (db.operadores.some(o => o.nome.toLowerCase() === nome.trim().toLowerCase())) return send(400, { error: "Já existe operador com esse nome" });
    const salt = crypto.randomBytes(8).toString("hex");
    db.operadores.push({ nome: nome.trim(), salt, hash: hashPin(pin, salt) });
    persistDb();
    return send(200, { ok: true });
  }

  // Remover operador
  if (url.pathname === "/api/operadores" && request.method === "DELETE") {
    if (!getSession(request)) return send(401, { error: "Não autorizado" });
    const nome = url.searchParams.get("nome");
    if (db.operadores.length <= 1) return send(400, { error: "Não é possível remover o único operador" });
    db.operadores = db.operadores.filter(o => o.nome !== nome);
    for (const [t, s] of Object.entries(db.sessions)) if (s.nome === nome) delete db.sessions[t];
    persistDb();
    return send(200, { ok: true });
  }

  // Login
  if (url.pathname === "/api/login" && request.method === "POST") {
    const { nome, pin } = JSON.parse(await readBody(request) || "{}");
    const op = db.operadores.find(o => o.nome === nome);
    if (!op || hashPin(pin || "", op.salt) !== op.hash) return send(401, { error: "Nome ou PIN incorretos" });
    const token = crypto.randomBytes(24).toString("hex");
    db.sessions[token] = { nome: op.nome, criado: Date.now() };
    for (const [t, s] of Object.entries(db.sessions)) {
      if (Date.now() - s.criado > 90 * 24 * 3600 * 1000) delete db.sessions[t];
    }
    persistDb();
    return send(200, { token, nome: op.nome });
  }

  // Upload de foto do acidente (autenticado) — 1 foto por requisição
  if (url.pathname === "/api/fotos" && request.method === "POST") {
    if (!getSession(request)) return send(401, { error: "Não autorizado" });
    const { eventoId, base64 } = JSON.parse(await readBody(request) || "{}");
    if (!eventoId || !base64) return send(400, { error: "Dados inválidos" });
    const dir = join(FOTOS_DIR, String(eventoId).replace(/[^a-z0-9-]/gi, ""));
    mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(8).toString("hex");
    writeFileSync(join(dir, id + ".jpg"), Buffer.from(base64, "base64"));
    return send(200, { id });
  }

  // Ver / excluir foto: /api/fotos/<eventoId>/<fotoId>
  const fotoMatch = url.pathname.match(/^\/api\/fotos\/([a-z0-9-]+)\/([a-f0-9]+)$/i);
  if (fotoMatch) {
    const token = url.searchParams.get("t") || (request.headers.authorization || "").replace("Bearer ", "");
    if (!db.sessions[token]) return send(401, { error: "Não autorizado" });
    const file = join(FOTOS_DIR, fotoMatch[1], fotoMatch[2] + ".jpg");
    if (!existsSync(file)) return send(404, { error: "Foto não encontrada" });
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
      createReadStream(file).pipe(response);
      return;
    }
    if (request.method === "DELETE") {
      unlinkSync(file);
      return send(200, { ok: true });
    }
  }

  // Dados do sistema (autenticado)
  if (url.pathname === "/api/state") {
    const session = getSession(request);
    if (!session) return send(401, { error: "Não autorizado" });
    if (request.method === "GET") return send(200, { state: db.state, rev: db.rev });
    if (request.method === "POST") {
      const { state } = JSON.parse(await readBody(request) || "{}");
      if (!state?.eventos || !state?.fornecedores) return send(400, { error: "Dados inválidos" });
      db.state = state;
      db.rev += 1;
      persistDb();
      return send(200, { rev: db.rev });
    }
  }

  send(404, { error: "Rota não encontrada" });
}

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

  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url).catch(error => {
      response.writeHead(500, JSON_HEADERS);
      response.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = normalize(join(root, relative));

  // Nunca servir o banco de dados nem arquivos do git
  if (filePath.startsWith(normalize(DATA_DIR)) || relative.includes(".git")) {
    response.writeHead(403);
    response.end("Acesso negado");
    return;
  }

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

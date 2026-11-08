// Простой сервер: отдаёт приложение и хранит данные для синхронизации.
// Переменные окружения: APP_PASSWORD (обязательно), DATA_DIR (папка для данных), PORT.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const STATIC = { "/": "index.html", "/index.html": "index.html", "/manifest.json": "manifest.json",
  "/sw.js": "sw.js", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png" };
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".png": "image/png" };

fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return { rev: 0, data: { weeks: {} } }; }
}
function store(obj) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, DATA_FILE);
}
function checkPassword(req) {
  if (!PASSWORD) return false;
  const given = Buffer.from(String(req.headers["x-password"] || ""));
  const real = Buffer.from(PASSWORD);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/data") {
    if (!checkPassword(req)) return send(res, 401, { error: "Неверный пароль" });
    if (req.method === "GET") return send(res, 200, load());
    if (req.method === "PUT") {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on("end", () => {
        let msg;
        try { msg = JSON.parse(body); } catch (e) { return send(res, 400, { error: "Плохой JSON" }); }
        if (!msg || !msg.data || typeof msg.data.weeks !== "object") return send(res, 400, { error: "Нет данных" });
        const cur = load();
        if (msg.baseRev !== cur.rev) return send(res, 409, cur); // кто-то успел записать раньше
        const next = { rev: cur.rev + 1, data: msg.data };
        store(next);
        send(res, 200, { rev: next.rev });
      });
      return;
    }
    return send(res, 405, { error: "Метод не поддерживается" });
  }

  const file = STATIC[url];
  if (req.method !== "GET" || !file) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("Сервер запущен на порту " + PORT));

// Сервер: отдаёт приложение, хранит аккаунты и данные каждого пользователя.
// Без внешних библиотек — только встроенные модули Node.js.
//
// Переменные окружения:
//   DATA_DIR      — папка для данных (на Railway — volume /data)
//   PORT          — порт
//   APP_PASSWORD  — старый пароль синхронизации (для переноса старых данных в аккаунт)
//   SEED_DEBTS    — JSON с начальными долгами, добавляется к старым данным при переносе
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_DIR = path.join(DATA_DIR, "users");
const USERS_FILE = path.join(DATA_DIR, "accounts.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const LEGACY_FILE = path.join(DATA_DIR, "data.json");          // данные старой синхронизации по паролю
const LEGACY_PASSWORD = process.env.APP_PASSWORD || "";

const SESSION_DAYS = 180;      // обычный вход
const TEMP_SESSION_HOURS = 24; // вход с чужого устройства

const STATIC = { "/": "index.html", "/index.html": "index.html", "/manifest.json": "manifest.json",
  "/sw.js": "sw.js", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png" };
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".png": "image/png" };

fs.mkdirSync(USERS_DIR, { recursive: true });

// ---------- файлы ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJSON(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const userFile = login => path.join(USERS_DIR, sha(login.toLowerCase()) + ".json");

let accounts = readJSON(USERS_FILE, {});     // login(lowercase) -> { login, salt, hash, created }
let sessions = readJSON(SESSIONS_FILE, {});  // sha(token) -> { login, expires }

// ---------- пароли и сессии ----------
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString("hex"); }
function checkPassword(acc, password) {
  const a = Buffer.from(hashPassword(password, acc.salt), "hex"), b = Buffer.from(acc.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newSession(login, temp) {
  const token = crypto.randomBytes(32).toString("hex");
  const ms = temp ? TEMP_SESSION_HOURS * 3600e3 : SESSION_DAYS * 86400e3;
  sessions[sha(token)] = { login, expires: Date.now() + ms };
  for (const [k, s] of Object.entries(sessions)) if (s.expires < Date.now()) delete sessions[k];
  writeJSON(SESSIONS_FILE, sessions);
  return token;
}
function sessionOf(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const s = sessions[sha(m[1])];
  if (!s || s.expires < Date.now() || !accounts[s.login]) return null;
  return { key: sha(m[1]), login: s.login };
}

// ---------- защита от подбора ----------
const attempts = new Map(); // ключ -> { count, until }
function tooMany(key, limit, minutes) {
  const now = Date.now(), a = attempts.get(key);
  if (!a || a.until < now) { attempts.set(key, { count: 1, until: now + minutes * 60e3 }); return false; }
  a.count++;
  return a.count > limit;
}
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

// ---------- данные пользователя ----------
function loadData(login) { return readJSON(userFile(login), { rev: 0, data: { weeks: {} } }); }
function saveData(login, obj) { writeJSON(userFile(login), obj); }

// Перенос данных старой синхронизации (по паролю) в новый аккаунт
function claimLegacy(login, legacyPassword) {
  const CLAIMED = LEGACY_FILE + ".claimed";
  if (!LEGACY_PASSWORD || !legacyPassword || fs.existsSync(CLAIMED)) return false; // переносится только один раз
  const a = Buffer.from(legacyPassword), b = Buffer.from(LEGACY_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const old = readJSON(LEGACY_FILE, null);
  const data = (old && old.data) || { weeks: {} };
  if (!data.weeks) data.weeks = {};
  if (!data.debts && process.env.SEED_DEBTS) {
    try { data.debts = JSON.parse(process.env.SEED_DEBTS); data.debts.updatedAt = Date.now(); } catch (e) { console.log("SEED_DEBTS: неверный JSON"); }
  }
  saveData(login, { rev: 1, data });
  if (fs.existsSync(LEGACY_FILE)) fs.renameSync(LEGACY_FILE, CLAIMED); else writeJSON(CLAIMED, {});
  return true;
}

// ---------- HTTP ----------
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req, cb) {
  let body = "";
  req.on("data", c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => { let j = null; try { j = JSON.parse(body || "{}"); } catch (e) {} cb(j); });
}
const LOGIN_RE = /^[A-Za-z0-9_.\-А-Яа-яЁё]{3,32}$/;

function api(req, res, url) {
  const ip = clientIp(req);

  if (url === "/api/register" && req.method === "POST") return readBody(req, b => {
    if (!b) return send(res, 400, { error: "Плохой запрос" });
    if (tooMany("reg:" + ip, 5, 60)) return send(res, 429, { error: "Слишком много попыток, попробуй позже" });
    const login = String(b.login || "").trim(), password = String(b.password || "");
    if (!LOGIN_RE.test(login)) return send(res, 400, { error: "Логин: 3–32 символа, буквы, цифры, _ . -" });
    if (password.length < 6) return send(res, 400, { error: "Пароль минимум 6 символов" });
    const key = login.toLowerCase();
    if (accounts[key]) return send(res, 409, { error: "Такой логин уже занят" });
    const salt = crypto.randomBytes(16).toString("hex");
    accounts[key] = { login, salt, hash: hashPassword(password, salt), created: Date.now() };
    writeJSON(USERS_FILE, accounts);
    const migrated = claimLegacy(key, b.legacyPassword);
    send(res, 200, { token: newSession(key, !!b.temp), login, migrated });
  });

  if (url === "/api/login" && req.method === "POST") return readBody(req, b => {
    if (!b) return send(res, 400, { error: "Плохой запрос" });
    const key = String(b.login || "").trim().toLowerCase();
    if (tooMany("ip:" + ip, 20, 15) || tooMany("login:" + key, 10, 15)) return send(res, 429, { error: "Слишком много попыток, подожди 15 минут" });
    const acc = accounts[key];
    if (!acc || !checkPassword(acc, String(b.password || ""))) return send(res, 401, { error: "Неверный логин или пароль" });
    attempts.delete("login:" + key);
    send(res, 200, { token: newSession(key, !!b.temp), login: acc.login });
  });

  const s = sessionOf(req);
  if (!s) return send(res, 401, { error: "Нужно войти" });

  if (url === "/api/logout" && req.method === "POST") {
    delete sessions[s.key]; writeJSON(SESSIONS_FILE, sessions);
    return send(res, 200, { ok: true });
  }

  if (url === "/api/password" && req.method === "POST") return readBody(req, b => {
    const acc = accounts[s.login];
    if (!b || !checkPassword(acc, String(b.old || ""))) return send(res, 401, { error: "Старый пароль неверный" });
    if (String(b.new || "").length < 6) return send(res, 400, { error: "Пароль минимум 6 символов" });
    acc.salt = crypto.randomBytes(16).toString("hex"); acc.hash = hashPassword(String(b.new), acc.salt);
    writeJSON(USERS_FILE, accounts);
    // выходим на всех других устройствах
    for (const [k, x] of Object.entries(sessions)) if (x.login === s.login && k !== s.key) delete sessions[k];
    writeJSON(SESSIONS_FILE, sessions);
    send(res, 200, { ok: true });
  });

  if (url === "/api/data") {
    if (req.method === "GET") return send(res, 200, loadData(s.login));
    if (req.method === "PUT") return readBody(req, msg => {
      if (!msg || !msg.data || typeof msg.data.weeks !== "object") return send(res, 400, { error: "Нет данных" });
      const cur = loadData(s.login);
      if (msg.baseRev !== cur.rev) return send(res, 409, cur); // кто-то успел записать раньше
      if (!msg.data.debts && cur.data.debts) msg.data.debts = cur.data.debts;
      const next = { rev: cur.rev + 1, data: msg.data };
      saveData(s.login, next);
      send(res, 200, { rev: next.rev });
    });
  }
  send(res, 404, { error: "Не найдено" });
}

// Приложение (APK/IPA) открывает сайт со своего адреса — разрешаем ему обращаться к API
const APP_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"];

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/")) {
    const origin = req.headers.origin;
    if (APP_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    return api(req, res, url);
  }

  const file = STATIC[url];
  if (req.method !== "GET" || !file) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("Сервер запущен на порту " + PORT));

// Копирует сайт из корня репозитория в mobile/www — оттуда Capacitor берёт файлы приложения
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const out = path.join(__dirname, "www");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of ["index.html", "manifest.json", "icon-192.png", "icon-512.png"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log("www готов");

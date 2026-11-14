// Собирает mobile/www — оттуда Capacitor берёт файлы приложения.
// index.html — загрузчик (берёт свежий сайт с сервера), app.html — копия сайта на случай без интернета.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const out = path.join(__dirname, "www");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
fs.copyFileSync(path.join(__dirname, "loader.html"), path.join(out, "index.html"));
fs.copyFileSync(path.join(root, "index.html"), path.join(out, "app.html"));
for (const f of ["manifest.json", "icon-192.png", "icon-512.png"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log("www готов");

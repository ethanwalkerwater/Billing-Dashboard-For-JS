import fs from "node:fs";

fs.rmSync("public", { recursive: true, force: true });
fs.mkdirSync("public", { recursive: true });
fs.cpSync("index.html", "public/index.html");
fs.cpSync("assets", "public/assets", { recursive: true });

console.log("built static app into public/");

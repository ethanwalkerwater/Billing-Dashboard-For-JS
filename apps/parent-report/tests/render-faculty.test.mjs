import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { renderFacultyCard } from "../src/render-faculty.mjs";

test("renderFacultyCard can optimize embedded photos as jpeg data uris", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jingshi-faculty-photo-"));
  const photo = path.join(tmp, "老师.png");
  const result = spawnSync("magick", [
    "-size", "1200x800",
    "gradient:#3f6fc7-#f2d27c",
    photo,
  ]);
  assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());

  const rawHtml = renderFacultyCard({
    name: "老师",
    photo: "老师.png",
    tag: "数学",
    desc: "简介",
    scores: {},
  }, {
    embed: true,
    photoDir: tmp,
  });
  const optimizedHtml = renderFacultyCard({
    name: "老师",
    photo: "老师.png",
    tag: "数学",
    desc: "简介",
    scores: {},
  }, {
    embed: true,
    photoDir: tmp,
    optimizeEmbeddedPhotos: true,
  });

  assert.match(optimizedHtml, /data:image\/jpeg;base64,/);
  assert.ok(optimizedHtml.length < rawHtml.length);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { concatObjects } from "../functions/classroom-api/index";

test("有序拼接并流式上传 100 MB 和 200 MB，成功或失败都清理临时文件", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "classroom-concat-test-"));
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  process.env.CLOUDBASE_ENV_ID = "test-env";
  process.env.CLOUDBASE_API_KEY = "test-key";
  t.after(async () => {
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    await rm(temporary, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(2_000_000 - 3, 42);
  const keys = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0"));
  const uploads: Array<{ length?: string; type?: string; digest: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      const [, size, key] = /\/(\d+)\/(\d{3})$/.exec(request.url ?? "") ?? [];
      if (!key) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": size });
      response.write(key);
      response.end(payload.subarray(0, Number(size) - 3));
      return;
    }
    const hash = createHash("sha256");
    for await (const chunk of request) hash.update(chunk);
    uploads.push({ length: request.headers["content-length"], type: request.headers["content-type"], digest: hash.digest("hex") });
    response.writeHead(request.url?.endsWith("/reject") ? 502 : 200).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const localUrl = (input: string) => new URL(new URL(input).pathname, origin);
  const fetchHttp = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string, init?: RequestInit) => fetchHttp(localUrl(input), init));
  t.mock.method(https, "request", (input: string, options: RequestOptions, onResponse?: (res: IncomingMessage) => void) =>
    request(localUrl(input), options, onResponse));

  for (const size of [1_000_000, 2_000_000]) {
    const hash = createHash("sha256");
    for (const key of keys) hash.update(key).update(payload.subarray(0, size - 3));
    const bytes = await concatObjects("result", keys.map((key) => `${size}/${key}`), "application/octet-stream");
    assert.equal(bytes, size * keys.length);
    assert.deepEqual(uploads.at(-1), {
      length: String(bytes), type: "application/octet-stream", digest: hash.digest("hex"),
    });
    assert.deepEqual(await readdir(temporary), []);
  }
  await assert.rejects(concatObjects("result", ["1000000/000", "missing"]), /下载分段失败/);
  assert.equal(uploads.length, 2);
  assert.deepEqual(await readdir(temporary), []);
  await assert.rejects(concatObjects("reject", ["1000000/000"]), /存储录音失败/);
  assert.deepEqual(await readdir(temporary), []);
});

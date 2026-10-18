import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export async function createMockJira(hang = false) {
  const directory = await mkdtemp(join(tmpdir(), "bluntjira-https-"));
  const certificate = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  try {
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", key, "-out", certificate,
    ]);
    const requests: { path: string | undefined; authorization: string | undefined; cookie: string | undefined }[] = [];
    const seen = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
      response.once("close", () => disconnected.resolve());
      seen.resolve();
      if (!hang) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify([{ key: "TEST", name: "Mock Jira" }]));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock Jira has no TCP port");
    return {
      url: `https://127.0.0.1:${address.port}/jira`,
      certificate, requests, seen: seen.promise, disconnected: disconnected.promise,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

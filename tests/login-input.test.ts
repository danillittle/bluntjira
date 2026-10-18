import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readHidden } from "../src/login.js";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; },
  });
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => { transcript += String(chunk); });
  return { input, output, transcript: () => transcript };
}

for (const chunkSize of [1, 2, 4096]) {
  test(`hidden password decodes UTF-8 split into ${chunkSize}-byte chunks`, async () => {
    const tty = terminal();
    const password = "пароль🔑:$@#";
    const result = readHidden("Password: ", tty.input, tty.output);
    const bytes = Buffer.from(`${password}\r`);
    for (let i = 0; i < bytes.length; i += chunkSize) tty.input.write(bytes.subarray(i, i + chunkSize));
    assert.equal(await result, password);
    assert.equal(tty.transcript(), "Password: \n");
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount("data"), 0);
  });
}

test("hidden input is ready in raw mode before displaying the password prompt", async () => {
  const tty = terminal();
  const output = new PassThrough();
  output.on("data", (chunk) => {
    if (String(chunk) === "Password: ") {
      assert.equal(tty.input.isRaw, true, "Do not prompt while terminal echo is enabled");
      assert.equal(tty.input.listenerCount("data"), 1);
      tty.input.write(Buffer.from("пароль\r"));
    }
  });
  assert.equal(await readHidden("Password: ", tty.input, output), "пароль");
});

test("Backspace deletes whole Unicode code points, including emoji", async () => {
  const tty = terminal();
  const result = readHidden("Password: ", tty.input, tty.output);
  tty.input.write(Buffer.from("пароль🔑\u007fX\bя\r"));
  assert.equal(await result, "паролья");
  assert.equal(tty.transcript(), "Password: \n");
});

test("Ctrl-C cancels hidden input and restores terminal state", async () => {
  const tty = terminal();
  const result = readHidden("Password: ", tty.input, tty.output);
  tty.input.write(Buffer.from("private\u0003"));
  await assert.rejects(result, /Login cancelled/);
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount("data"), 0);
  assert.equal(tty.transcript(), "Password: \n");
});

test("hidden input rejects non-interactive streams without consuming input", async () => {
  const tty = terminal();
  tty.input.isTTY = false;
  await assert.rejects(readHidden("Password: ", tty.input, tty.output), /interactive terminal/);
  assert.equal(tty.transcript(), "");
  assert.equal(tty.input.listenerCount("data"), 0);
});

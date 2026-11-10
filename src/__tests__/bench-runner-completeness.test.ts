import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { defaultRunTeProgram } from "../bench.js";

function fakeProgram(chunks: Buffer[], code = 0, stderr = "") {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined,
    kill: vi.fn(),
  });
  const spawnProgram = vi.fn(() => {
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stderr.write(Buffer.from(stderr));
      child.emit("close", code, null);
    });
    return child;
  });
  return { child, spawnProgram };
}

describe("F-07 structured runner byte boundary", () => {
  it("marks an exit0 UTF-8 prefix incomplete and measures every emitted byte", async () => {
    const fake = fakeProgram([Buffer.from([0xd0]), Buffer.from([0x96, 0xd0, 0x96]), Buffer.from("abc")]);
    const run = await defaultRunTeProgram("fake", ["literal"], {
      maxBufferBytes: 3, spawnProgram: fake.spawnProgram as never,
    });
    expect(run).toMatchObject({
      stdout: "Ж", stdoutBytes: 7, stdoutCapturedBytes: 2,
      stdoutTruncated: true, exitCode: 0, completeness: "truncated",
    });
    expect(run.stdout).not.toContain("�");
  });

  it.each([2, 4, 5])("handles a %i-byte cap without losing UTF-8 boundaries", async (cap) => {
    const fake = fakeProgram([Buffer.from([0xd0]), Buffer.from([0x96, 0xd0, 0x96])]);
    const run = await defaultRunTeProgram("fake", [], { maxBufferBytes: cap, spawnProgram: fake.spawnProgram as never });
    expect(run.stdoutBytes).toBe(4);
    expect(run.stdout).toBe(cap === 2 ? "Ж" : "ЖЖ");
    expect(run.completeness).toBe(cap < 4 ? "truncated" : "complete");
  });

  it("bounds stderr separately without declaring a complete stdout truncated", async () => {
    const fake = fakeProgram([Buffer.from("ok")], 0, "12345");
    const run = await defaultRunTeProgram("fake", [], { maxBufferBytes: 3, spawnProgram: fake.spawnProgram as never });
    expect(run).toMatchObject({ stdout: "ok", stdoutBytes: 2, stderrBytes: 5, stderrTruncated: true, completeness: "complete" });
  });

  it("retains the HAR negative exit1 payload instead of discarding it", async () => {
    const fake = fakeProgram([Buffer.from('{"total":0,"items":[]}')], 1);
    const run = await defaultRunTeProgram("fake", [], { spawnProgram: fake.spawnProgram as never });
    expect(run).toMatchObject({ exitCode: 1, stdout: '{"total":0,"items":[]}', completeness: "complete" });
  });

  it("does not claim a dangling UTF-8 sequence is a complete successful payload", async () => {
    const fake = fakeProgram([Buffer.from([0xd0])]);
    const run = await defaultRunTeProgram("fake", [], { spawnProgram: fake.spawnProgram as never });
    expect(run).toMatchObject({ stdout: "", stdoutBytes: 1, stdoutCapturedBytes: 0, completeness: "unknown", error: "incomplete UTF-8 stdout" });
  });

  it("reports nonzero errors and own timeout rather than an exact success", async () => {
    const failure = fakeProgram([], 2);
    expect(await defaultRunTeProgram("fake", [], { spawnProgram: failure.spawnProgram as never })).toMatchObject({ exitCode: 2, completeness: "unknown", error: "exit code 2" });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.emit("close", null, "SIGTERM"); return true; });
    const run = await defaultRunTeProgram("fake", [], { timeoutMs: 1, spawnProgram: (() => child) as never });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(run).toMatchObject({ completeness: "unknown", error: "timeout after 1 ms (own process tree terminated)" });
  });
});

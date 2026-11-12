import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_SAMPLE,
  QUALITY,
  frameVerdict,
} from "../frontend/src/table3d/quality.ts";

const run = (n: number, seconds: number) => Array(n).fill(seconds);

test("frame verdict waits for enough real frames", () => {
  assert.equal(frameVerdict(run(FRAME_SAMPLE.count - 1, 1 / 60)), null);
  // Idle gaps and a hidden, throttled page are not frames at all.
  assert.equal(frameVerdict(run(100, 0.4)), null);
  assert.equal(frameVerdict(run(100, 0.001)), null);
});

test("smooth runs pass, sustained slow runs do not", () => {
  assert.equal(frameVerdict(run(30, 1 / 60)), "ok");
  assert.equal(frameVerdict(run(30, 1 / 45)), "ok");
  assert.equal(frameVerdict(run(30, 1 / 20)), "slow");
  // A few hitches in a smooth run do not count as slow.
  assert.equal(frameVerdict([...run(24, 1 / 60), ...run(6, 0.2)]), "ok");
});

test("quality steps only get cheaper", () => {
  for (let i = 1; i < QUALITY.length; i++) {
    assert.ok(QUALITY[i].dpr[1] <= QUALITY[i - 1].dpr[1]);
    assert.ok(QUALITY[i].shadowSize <= QUALITY[i - 1].shadowSize);
    assert.ok(
      !QUALITY[i - 1].shadows || QUALITY[i].shadows <= QUALITY[i - 1].shadows,
    );
  }
  assert.equal(QUALITY.at(-1)!.shadows, false);
});

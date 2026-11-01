import test from "node:test";
import assert from "node:assert/strict";
import { AuthClock } from "../frontend/src/auth-clock.ts";
test("V3 T06/T31: server deadlines stay ten minutes despite an incorrect browser clock", () => {
  let elapsed = 100;
  const clock = new AuthClock(() => elapsed, 123);
  const server = 2000000000000,
    deadline = server + 600000;
  clock.sync(server);
  assert.equal(Math.ceil((deadline - clock.now()) / 60000), 10);
  elapsed += 60000;
  assert.equal(deadline - clock.now(), 540000);
  elapsed += 540000;
  assert.equal(deadline - clock.now(), 0);
});
test("V3 T06/T31: resynchronization uses the current server response and ignores invalid timestamps", () => {
  let elapsed = 0;
  const clock = new AuthClock(() => elapsed, 1000);
  elapsed = 100;
  assert.equal(clock.now(), 1100);
  clock.sync(5000);
  elapsed = 200;
  assert.equal(clock.now(), 5100);
  clock.sync(Number.NaN);
  clock.sync(undefined);
  elapsed = 300;
  assert.equal(clock.now(), 5200);
});

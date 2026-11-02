import { avatarPNG } from "./avatar-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { deflateSync } from "node:zlib";
import { normalizeAvatar } from "../backend/src/social/avatar-image.ts";
import { fixture } from "./social-fixture.ts";
import { YAKU_CATALOG, exampleHand } from "../shared/yaku-catalog.ts";
import {
  score,
  SUPPORTED_YAKU_IDS,
  type ScoreContext,
} from "../backend/src/rules.ts";
import { kind, type Meld } from "../shared/types.ts";
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const v of body) {
    crc ^= v;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
test("V4.1 avatar decoding is bounded, rejects spoofed/damaged/animated images, strips metadata", () => {
  const png = avatarPNG();
  const metadata = chunk("tEXt", Buffer.from("Comment\0private-test-metadata"));
  const tagged = Buffer.concat([
    png.subarray(0, 33),
    metadata,
    png.subarray(33),
  ]);
  const clean = normalizeAvatar(tagged);
  assert(!clean.includes(Buffer.from("private-test-metadata")));
  assert.deepEqual(PNG.sync.read(clean).data, PNG.sync.read(png).data);
  const interlaced = Buffer.from(png);
  interlaced[28] = 1;
  const wrongSize = Buffer.from(png);
  wrongSize.writeUInt32BE(100000, 16);
  const corrupt = Buffer.from(png);
  corrupt[40] ^= 128;
  const bomb = Buffer.concat([
    png.subarray(0, 33),
    chunk("IDAT", deflateSync(Buffer.alloc(4 * 1024 * 1024))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  for (const bad of [
    Buffer.from("<svg><script/></svg>"),
    Buffer.alloc(301 * 1024),
    interlaced,
    wrongSize,
    corrupt,
    bomb,
    Buffer.concat([png, Buffer.from("trailing")]),
    Buffer.concat([
      png.subarray(0, 33),
      chunk("acTL", Buffer.alloc(8)),
      png.subarray(33),
    ]),
  ])
    assert.throws(
      () => normalizeAvatar(bad),
      (e: any) => e.code === "INVALID_AVATAR_IMAGE",
    );
});
test("V4.1 avatar ownership, immutable asset, CAS, idempotence and room occupancy", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const png = avatarPNG();
  const ctx = f.ctx(0);
  const uploaded = await f.social.uploadAvatar(ctx, png, 1);
  assert.equal(uploaded.profileVersion, 2);
  assert.match(uploaded.avatarId, /^upload_/);
  assert.deepEqual(await f.social.uploadAvatar(ctx, png, 1), uploaded);
  assert.equal((await f.social.profile(f.ctx(0))).lastNicknameChangedAt, null);
  const bytes = (await f.social.avatarImage(uploaded.avatarId)).bytes;
  await f.social.updateProfile(f.ctx(0), {
    displayName: "Avatar owner",
    avatarId: "crane",
    expectedProfileVersion: 2,
  });
  assert.deepEqual(
    (await f.social.avatarImage(uploaded.avatarId)).bytes,
    bytes,
  );
  await assert.rejects(
    f.social.updateProfile(f.ctx(1), {
      displayName: "Other",
      avatarId: uploaded.avatarId,
      expectedProfileVersion: 1,
    }),
    (e: any) => e.code === "INVALID_AVATAR",
  );
  await assert.rejects(
    f.social.uploadAvatar(f.ctx(0), avatarPNG(1), 2),
    (e: any) => e.code === "PROFILE_VERSION_CONFLICT",
  );
  const same = await f.social.uploadAvatar(f.ctx(0), png, 3);
  assert.equal(same.avatarId, uploaded.avatarId);
  await f.room([0]);
  await assert.rejects(
    f.social.uploadAvatar(f.ctx(0), avatarPNG(1), 4),
    (e: any) => e.code === "PROFILE_CHANGE_IN_ROOM",
  );
  assert.equal(
    Number(
      (await f.store.transaction((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM avatar_assets"),
      ))!.n,
    ),
    1,
  );
  await assert.rejects(
    f.social.avatarImage("../../service.env"),
    (e: any) => e.code === "NOT_FOUND",
  );
});
test("V4.1 avatar transaction rollback and restart preserve image references", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const tx = f.store.transaction.bind(f.store);
  let fail = true;
  f.store.transaction = (fn) =>
    tx(async (q) => {
      const r = await fn(q);
      if (fail && (await q.one("SELECT avatar_id FROM avatar_assets"))) {
        fail = false;
        throw Error("ROLLBACK_AVATAR");
      }
      return r;
    });
  const ctx = f.ctx(0);
  await assert.rejects(
    f.social.uploadAvatar(ctx, avatarPNG(), 1),
    /ROLLBACK_AVATAR/,
  );
  f.store.transaction = tx;
  assert.equal(
    Number(
      (await tx((q) => q.one("SELECT COUNT(*) AS n FROM avatar_assets")))!.n,
    ),
    0,
  );
  assert.equal((await f.social.profile(f.ctx(0))).profileVersion, 1);
  const r = await f.social.uploadAvatar(ctx, avatarPNG(), 1);
  await f.auth.initialize();
  assert.equal((await f.social.profile(f.ctx(0))).avatarId, r.avatarId);
});
test("V4.1 all supported yaku have a physically valid hand that scores the named yaku", () => {
  const checks: {
    id: string;
    name: string;
    physicalTiles: number;
    scoredYaku: string[];
  }[] = [];
  assert.equal(YAKU_CATALOG.length, 42);
  assert.deepEqual(
    [...new Set(YAKU_CATALOG.map((y) => y.id))].sort(),
    [...new Set(SUPPORTED_YAKU_IDS)].sort(),
  );
  for (const example of YAKU_CATALOG) {
    const { groups, winning } = exampleHand(example);
    const melds: Meld[] = [],
      concealed: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const tiles = groups[i],
        open = example.open?.includes(i);
      if (open || tiles.length === 4)
        melds.push({
          meldId: "example-" + i,
          type:
            tiles.length === 4
              ? open
                ? "DAIMINKAN"
                : "ANKAN"
              : kind(tiles[0]) === kind(tiles[1])
                ? "PON"
                : "CHI",
          tiles,
          sourceSeat: open ? 0 : null,
          sourceDiscardId: open ? "example-discard" : null,
          calledTile: open ? tiles[0] : null,
          addedTile: null,
        });
      else concealed.push(...tiles);
    }
    assert(
      concealed.includes(winning),
      example.id + " winning tile must be concealed",
    );
    const equivalent =
      groups.flat().length - melds.filter((m) => m.tiles.length === 4).length;
    assert.equal(equivalent, 14, example.id);
    const state = example.context ?? {};
    const c: ScoreContext = {
      seat: state.seat ?? 1,
      dealer: 0,
      round: state.round ?? 0,
      tiles: concealed.filter((t) => t !== winning),
      drawn: state.tsumo ? winning : null,
      melds,
      winningTile: winning,
      source: state.tsumo ? null : 0,
      riichi: state.riichi ?? 0,
      ippatsu: state.ippatsu ?? false,
      haitei: state.haitei ?? false,
      rinshan: state.rinshan ?? false,
      chankan: state.chankan ?? false,
      first: state.first ?? false,
      indicators: [],
      ura: [],
    };
    const result = score(c);
    assert(
      result?.yaku.some((y) => y.yakuId === example.id),
      example.id + ": " + JSON.stringify(result?.yaku),
    );
    checks.push({
      id: example.id,
      name: example.name,
      physicalTiles: groups.flat().length,
      scoredYaku: result!.yaku.map((y) => y.yakuId),
    });
  }
  writeFileSync(
    "reports/v41-yaku-examples.json",
    JSON.stringify(
      {
        allSupportedYaku: 42,
        physicalTileChecksPassed: true,
        scoringContextChecksPassed: true,
        checks,
        passed: true,
      },
      null,
      2,
    ),
  );
});

test("V4.1 upload rate remains durable and failed uploads create no orphan assets", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let version = 1;
  for (let i = 0; i < 5; i++) {
    const r = await f.social.uploadAvatar(f.ctx(0), avatarPNG(i), version);
    version = r.profileVersion;
  }
  await f.auth.initialize();
  await assert.rejects(
    f.social.uploadAvatar(f.ctx(0), avatarPNG(9), version),
    (e: any) => e.code === "SOCIAL_RATE_LIMITED" && e.retryAfter > 0,
  );
  assert.equal(
    Number(
      (await f.store.transaction((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM avatar_assets"),
      ))!.n,
    ),
    5,
  );
});
test("V4.1 cleanup keeps frozen match avatars and only prunes old unreferenced images", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first = await f.social.uploadAvatar(f.ctx(0), avatarPNG(1), 1);
  await f.store.commit([
    {
      kind: "match",
      id: "avatar-reference-fixture",
      data: { players: [{ avatarId: first.avatarId }] },
    },
  ]);
  const second = await f.social.uploadAvatar(f.ctx(0), avatarPNG(2), 2);
  f.advance(8 * 86400000);
  await f.social.uploadAvatar(f.ctx(0), avatarPNG(3), 3);
  await f.social.uploadAvatar(f.ctx(0), avatarPNG(4), 4);
  assert((await f.social.avatarImage(first.avatarId)).bytes.length);
  await assert.rejects(
    f.social.avatarImage(second.avatarId),
    (e: any) => e.code === "NOT_FOUND",
  );
  assert.equal(
    Number(
      (await f.store.transaction((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM avatar_assets"),
      ))!.n,
    ),
    3,
  );
});

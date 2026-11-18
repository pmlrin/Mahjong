import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';

const origin = 'https://mahjong.yangjm.cn';
const avatarPath = '/api/v2/profile/avatar';
const image = new PNG({width: 256, height: 256});
image.data = randomBytes(image.data.length);
const body = PNG.sync.write(image);
assert(body.length > 32 * 1024 && body.length < 300 * 1024);

const upload = (payload) => fetch(origin + avatarPath, {
  method: 'PUT',
  headers: {Origin: origin, 'Content-Type': 'image/png', 'X-Profile-Version': '1', 'Idempotency-Key': randomUUID()},
  body: payload,
});
const acceptedByProxy = await upload(body);
if (process.argv.includes('--before')) {
  assert.equal(acceptedByProxy.status, 413);
  console.log(JSON.stringify({avatarBytes: body.length, rejectedByProxyBeforeRelease: true}));
} else {
  assert.equal(acceptedByProxy.status, 401);
  assert.equal((await acceptedByProxy.json()).error.code, 'UNAUTHENTICATED');
  const tooLarge = await upload(Buffer.alloc(321 * 1024));
  assert.equal(tooLarge.status, 413);
  const suggestions = await fetch(origin + '/api/v2/friends/suggestions');
  assert.equal(suggestions.status, 401);
  assert.equal((await suggestions.json()).error.code, 'UNAUTHENTICATED');
  console.log(JSON.stringify({avatarBytes: body.length, reachedApplication: true, oversizedStatus: tooLarge.status, suggestionsRequireLogin: true}));
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '/Users/yangjm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const cwd = readFileSync('/tmp/mahjong-146cbbe-builddir', 'utf8').trim();
const origin = 'http://127.0.0.1:3197';
const server = spawn(process.execPath, ['dist-server/backend/src/server.js'], {
  cwd,
  env: { ...process.env, NODE_ENV: 'test', FAST_TEST: '1', DATABASE_URL: '', SQLITE_PATH: cwd + '/lobby-browser.sqlite', HOST: '127.0.0.1', PORT: '3197', STATIC_DIR: cwd + '/dist', PUBLIC_ORIGIN: origin, MATCH_BOT_FILL_MS: '30000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (text) => { logs += text; });
server.stderr.on('data', (text) => { logs += text; });
let browser;
const errors = [];
const completed = [];
const exactButton = (page, name) => page.getByRole('button', { name, exact: true });
try {
  let healthy = false;
  for (let attempt = 0; attempt < 120 && !healthy; attempt++) {
    if (server.exitCode !== null) break;
    healthy = await fetch(origin + '/healthz').then((r) => r.ok).catch(() => false);
    if (!healthy) await delay(50);
  }
  assert(healthy, logs);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const ps = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('牌桌上的名字').fill('大厅验证' + (i + 1));
    await exactButton(page, '入座').click();
    await exactButton(page, '点灯开桌').waitFor();
    await page.getByRole('heading', {name: '公共牌桌', exact: true}).waitFor();
    return page;
  }));
  const [host, joiner] = ps;
  await host.getByText('公开到大厅，谁路过都能坐下', {exact: true}).click();
  await exactButton(host, '点灯开桌').click();
  const listed = joiner.locator('.public-room').filter({ hasText: '大厅验证1 的牌桌' });
  await listed.getByRole('button', { name: '入座', exact: true }).click();
  await exactButton(joiner, '离开').waitFor();
  await host.getByText('大厅验证2', {exact: true}).first().waitFor();
  await exactButton(joiner, '离开').click();
  await exactButton(host, '离开').click();
  await listed.waitFor({ state: 'detached' });
  completed.push('public room appears, accepts another player, and leaves lobby after closing');
  await exactButton(host, '随机匹配').click();
  await host.getByText('正在找牌友', {exact: true}).waitFor();
  await exactButton(host, '不等了').click();
  await exactButton(host, '随机匹配').waitFor();
  completed.push('queue can be cancelled');
  await Promise.all(ps.map((page) => exactButton(page, '随机匹配').click()));
  await Promise.all(ps.map((page) => page.locator('.play-page').waitFor({ timeout: 15000 })));
  const games = await Promise.all(ps.map((page) => page.evaluate(async () => (await (await fetch('/api/v2/me')).json()).data.matchId)));
  assert(games[0]);
  assert.equal(new Set(games).size, 1);
  assert.deepEqual(errors, []);
  completed.push('four browser sessions enter the same matched game');
  console.log(JSON.stringify({ passed: completed, pageErrors: errors }));
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const ended = once(server, 'exit');
    server.kill();
    await ended;
  }
}

import { createServer } from "vite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fixture } from "../tests/v42-fixture.ts";
// The desktop bundled Playwright can be supplied without changing production dependencies.
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const pw = await import(playwrightModule);
const server = await createServer({
  configFile: "frontend/vite.config.ts",
  server: { port: 5178, strictPort: true },
  plugins: [
    {
      name: "v42-test-only",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/__v42_frame") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(fixture()));
          } else if (req.url === "/__v42_fixture") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("tests/v42-browser-fixture.tsx")}"></script></body></html>`,
            );
          } else next();
        });
      },
    },
  ],
});
const report: any = {
  at: new Date().toISOString(),
  scope:
    "real browser events against production Game with deterministic authority/transport fixture",
  browsers: [],
  devices: "emulation only; no physical device or Windows verification",
  deployment: false,
};
await server.listen();
try {
  for (const name of ["chromium", "webkit"]) {
    let browser: any;
    try {
      browser = await pw[name].launch({
        headless: true,
        ...(name === "chromium" ? { channel: "chrome" } : {}),
      });
    } catch (error) {
      report.browsers.push({
        name,
        available: false,
        reason: String(error).split("\n")[0],
      });
      continue;
    }
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      hasTouch: name === "chromium",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.route("**/api/v2/matches/**/requests/**", (route: any) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: "not found" },
        }),
      }),
    );
    await page.goto("http://127.0.0.1:5178/__v42_fixture");
    await page.waitForFunction(() => !!(window as any).v42);
    const passed: string[] = [];
    const count = () => page.evaluate(() => (window as any).v42.events.length);
    const reset = async (kind = "draw", preserve = false) => {
      const generation = await page.evaluate(
        ({ kind, preserve }: any) => (window as any).v42.reset(kind, preserve),
        { kind, preserve },
      );
      await page.waitForFunction((generation: number) => {
        const panel = document.querySelector(
          `[data-browser-generation="${generation}"] .hand-panel`,
        );
        return (
          panel &&
          !panel
            .querySelector(".auto-status")
            ?.textContent?.includes("正在与牌桌同步")
        );
      }, generation);
    };
    const check = async (label: string, fn: () => Promise<void>) => {
      console.log(name + ": " + label);
      try {
        await fn();
        passed.push(label);
      } catch (error) {
        report.browsers.push({
          name,
          passed,
          consoleErrors: errors,
          failed: label,
        });
        await page.screenshot({
          path: resolve("reports/v42-browser-failure.png"),
          fullPage: true,
        });
        await browser.close();
        throw error;
      }
    };
    const quick = () =>
      page.getByRole("checkbox", { name: /快速出牌/ }).check();
    // Keys are always on; focusing the hand region stands in for a player
    // whose focus is on the table.
    const keyboard = () => page.locator(".hand-panel").focus();
    const tile = (id: number) => page.locator(`[data-hand-tile="${id}"]`);
    const eventOption = () =>
      page.evaluate(() => (window as any).v42.events.at(-1)?.payload.optionId);
    await check("defaults and normal select-confirm", async () => {
      await reset();
      assert.equal(await page.getByRole("checkbox").count(), 3);
      for (const x of await page.getByRole("checkbox").all())
        assert.equal(await x.isChecked(), false);
      await tile(16).click();
      assert.equal(await count(), 0);
      await page.getByRole("button", { name: /^打出/ }).click();
      assert.equal(await eventOption(), "discard-16");
    });
    await check(
      "quick click exact red copy; double click and duplicate frame stay locked",
      async () => {
        await reset();
        await quick();
        await tile(16).dblclick();
        assert.equal(await count(), 1);
        assert.equal(await eventOption(), "discard-16");
        await page.evaluate(() => (window as any).v42.duplicate());
        await page.waitForTimeout(30);
        assert.equal(await count(), 1);
      },
    );
    await check("quick riichi selects then confirms", async () => {
      await reset("riichi");
      await quick();
      await page.getByRole("button", { name: "立直", exact: true }).click();
      await tile(16).click();
      assert.equal(await count(), 0);
      await page.getByRole("button", { name: /立直并打出/ }).click();
      assert.equal(await eventOption(), "riichi-16");
    });
    await check(
      "keyboard always selects then Enter; held Enter cannot cross decision",
      async () => {
        await reset();
        await quick();
        await keyboard();
        await page.keyboard.press("Enter");
        assert.equal(await count(), 0);
        await page.keyboard.press("End");
        assert.equal(await count(), 0);
        await page.keyboard.down("Enter");
        assert.equal(await eventOption(), "discard-18");
        await page.evaluate(() => (window as any).v42.next());
        await page.waitForTimeout(30);
        await page.keyboard.down("Enter");
        assert.equal(await count(), 1);
        await page.keyboard.up("Enter");
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        assert.equal(await count(), 2);
      },
    );
    await check(
      "keys work with nothing focused, without a click first",
      async () => {
        await reset();
        await page.evaluate(() =>
          (document.activeElement as HTMLElement)?.blur(),
        );
        await page.keyboard.press("End");
        assert.equal(await count(), 0);
        await page.keyboard.press("Enter");
        assert.equal(await eventOption(), "discard-18");
      },
    );
    await check(
      "keyboard native tile activation selects without quick discard or dual activation",
      async () => {
        await reset();
        await quick();
        await keyboard();
        await tile(16).focus();
        await page.keyboard.press("Enter");
        assert.equal(await count(), 0);
        assert.equal(await tile(16).getAttribute("aria-pressed"), "true");
        await page.getByRole("button", { name: /^打出/ }).focus();
        await page.keyboard.press("Enter");
        assert.equal(await count(), 1);
      },
    );
    await check(
      "call opens first, arrows choose physical consumption, new Enter confirms",
      async () => {
        await reset("call");
        await keyboard();
        await page.keyboard.down("c");
        assert.equal(await count(), 0);
        await page.keyboard.down("c");
        assert.equal(await count(), 0);
        await page.keyboard.up("c");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        assert.equal(await eventOption(), "chi-normal");
      },
    );
    await check(
      "W and Space confirmations, cancel default and Escape never PASS",
      async () => {
        await reset("ron");
        await keyboard();
        await page.keyboard.press("w");
        assert.equal(await count(), 0);
        await page.keyboard.press("Escape");
        assert.equal(await count(), 0);
        await page.keyboard.press("Space");
        await page.waitForTimeout(10);
        assert.match(
          await page.evaluate(() => document.activeElement?.textContent),
          /留着荣和/,
        );
        await page.keyboard.press("Enter");
        assert.equal(await count(), 0);
        await page.getByRole("button", { name: "过", exact: true }).click();
        await page.getByRole("button", { name: "确定过" }).click();
        assert.equal(await eventOption(), "pass");
      },
    );
    await check(
      "input focus, composing input and modifiers isolate shortcuts",
      async () => {
        await reset();
        await keyboard();
        await page.getByRole("textbox", { name: "测试输入框" }).focus();
        await page.keyboard.press("r");
        await page.keyboard.press("Enter");
        assert.equal(await count(), 0);
        await keyboard();
        await page.keyboard.press("Meta+ArrowRight");
        await page
          .locator(".hand-panel")
          .dispatchEvent("keydown", { key: "Enter", isComposing: true });
        assert.equal(await count(), 0);
      },
    );
    await check(
      "pointer drag >8px, cross-tile, cancel, secondary and multi-touch never discard",
      async () => {
        for (const mode of ["drag", "cross", "cancel", "secondary", "multi"]) {
          await reset();
          await quick();
          const b = await tile(16).boundingBox();
          const c = await tile(17).boundingBox();
          if (mode === "drag" || mode === "cross") {
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
            await page.mouse.down();
            await page.mouse.move(
              mode === "cross" ? c.x + c.width / 2 : b.x + b.width / 2 + 12,
              b.y + b.height / 2,
            );
            await page.mouse.up();
          } else {
            await tile(16).dispatchEvent("pointerdown", {
              pointerId: 1,
              pointerType: "touch",
              isPrimary: mode !== "secondary",
              button: 0,
              clientX: 10,
              clientY: 10,
            });
            if (mode === "multi")
              await tile(17).dispatchEvent("pointerdown", {
                pointerId: 2,
                pointerType: "touch",
                isPrimary: false,
                button: 0,
                clientX: 12,
                clientY: 10,
              });
            if (mode === "cancel")
              await tile(16).dispatchEvent("pointercancel", { pointerId: 1 });
            await tile(16).dispatchEvent("pointerup", {
              pointerId: 1,
              button: 0,
              clientX: 10,
              clientY: 10,
            });
            await tile(16).dispatchEvent("click", { detail: 1 });
          }
          assert.equal(await count(), 0, mode);
        }
      },
    );
    await check(
      "auto-discard waits 500ms; manual selection cancels without rerender rearming",
      async () => {
        await reset();
        await page
          .getByRole("checkbox", { name: "自动摸切", exact: true })
          .check();
        await page.waitForTimeout(120);
        assert.equal(await count(), 0);
        await tile(16).click();
        await page.evaluate(() => (window as any).v42.duplicate());
        await page.waitForTimeout(550);
        assert.equal(await count(), 0);
        await reset();
        const start = performance.now();
        await page
          .getByRole("checkbox", { name: "自动摸切", exact: true })
          .check();
        await page.waitForFunction(
          () => (window as any).v42.events.length === 1,
        );
        assert(performance.now() - start >= 490);
        assert.equal(await eventOption(), "discard-18");
      },
    );
    await check(
      "no-call PASS, RON preservation and disabled call entries",
      async () => {
        await reset("call");
        await page.getByRole("checkbox", { name: /不鸣牌/ }).check();
        await page.waitForFunction(
          () => (window as any).v42.events.length === 1,
        );
        assert.equal(await eventOption(), "pass");
        await reset("ron");
        await page.getByRole("checkbox", { name: /不鸣牌/ }).check();
        await page.waitForTimeout(600);
        assert.equal(await count(), 0);
        assert.equal(
          await page
            .getByRole("button", { name: "吃", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "荣和", exact: true })
            .isEnabled(),
          true,
        );
        await page.getByRole("checkbox", { name: /不鸣牌/ }).uncheck();
        assert.equal(
          await page
            .getByRole("button", { name: "吃", exact: true })
            .isEnabled(),
          true,
        );
      },
    );
    await check(
      "special choices and near-deadline do not auto-discard",
      async () => {
        for (const kind of ["tsumo", "ankan", "kakan", "abort", "short"]) {
          await reset(kind);
          await page
            .getByRole("checkbox", { name: "自动摸切", exact: true })
            .check();
          await page.waitForTimeout(550);
          assert.equal(await count(), 0, kind);
        }
      },
    );
    await check(
      "blur and disconnect disable automatic modes, and resume never reenables",
      async () => {
        for (const mode of ["blur", "disconnect"]) {
          await reset();
          await page
            .getByRole("checkbox", { name: "自动摸切", exact: true })
            .check();
          if (mode === "blur")
            await page.evaluate(() => window.dispatchEvent(new Event("blur")));
          else await page.evaluate(() => (window as any).v42.disconnect());
          await page.waitForTimeout(550);
          assert.equal(await count(), 0);
          assert.equal(
            await page
              .getByRole("checkbox", { name: "自动摸切", exact: true })
              .isChecked(),
            false,
          );
          if (mode === "blur")
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          else await page.evaluate(() => (window as any).v42.reconnect());
        }
      },
    );
    await check(
      "lost ack plus receipt 404 never unlocks or generates another intent",
      async () => {
        await reset();
        await page.evaluate(() => (window as any).v42.lose());
        await quick();
        await tile(16).click();
        await page.waitForTimeout(300);
        assert.equal(await count(), 1);
        assert.equal(await tile(17).isDisabled(), true);
        await page.evaluate(() => (window as any).v42.duplicate());
        await page.waitForTimeout(100);
        assert.equal(await count(), 1);
      },
    );
    await check(
      "quick preference survives remount while automatic modes reset",
      async () => {
        await reset();
        await quick();
        await keyboard();
        await page.getByRole("checkbox", { name: /不鸣牌/ }).check();
        await reset("draw", true);
        assert.equal(
          await page.getByRole("checkbox", { name: /快速出牌/ }).isChecked(),
          true,
        );
        assert.equal(
          await page.getByRole("checkbox", { name: /不鸣牌/ }).isChecked(),
          false,
        );
      },
    );
    await check(
      "unavailable browser preference and recovery storage still allow manual play",
      async () => {
        await page.evaluate(() => {
          (window as any).savedStorage = {
            getItem: Storage.prototype.getItem,
            setItem: Storage.prototype.setItem,
          };
          Storage.prototype.getItem = () => {
            throw Error("disabled");
          };
          Storage.prototype.setItem = () => {
            throw Error("disabled");
          };
        });
        await reset();
        assert.equal(
          await page.getByRole("checkbox", { name: /快速出牌/ }).isChecked(),
          false,
        );
        await quick();
        assert.equal(
          await page
            .getByText("这台设备记不住设置，本次照常可用", { exact: true })
            .isVisible(),
          true,
        );
        await tile(16).click();
        assert.equal(await eventOption(), "discard-16");
        await page.evaluate(() => {
          Object.assign(Storage.prototype, (window as any).savedStorage);
        });
      },
    );
    await reset();
    await page
      .getByRole("textbox", { name: "测试输入框" })
      .evaluate((el: HTMLElement) => {
        el.hidden = true;
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: resolve(`reports/v42-${name}-narrow.png`),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    if (name === "chromium") {
      await quick();
      await tile(16).tap();
      assert.equal(await eventOption(), "discard-16");
      passed.push("touchscreen tap exact physical tile at 390px (emulated)");
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({
      path: resolve(`reports/v42-${name}-desktop.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    report.browsers.push({
      name,
      version: browser.version(),
      passed,
      count: passed.length,
      consoleErrors: errors,
    });
    console.log(name + ": " + passed.length + " browser scenarios passed");
    await context.close();
    await browser.close();
  }
  assert(
    report.browsers.some((b: any) => b.count > 0),
    "No real browser tests ran",
  );
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  writeFileSync(
    "reports/v42-browser.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await server.close();
}

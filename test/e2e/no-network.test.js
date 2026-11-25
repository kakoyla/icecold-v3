// SPEC §7.1 no-network test: the built HTML makes zero requests in a
// headless browser. SPEC §4.1: tests prove no network API is reachable.
//
// A local "canary" HTTP server counts every request it receives. The page is
// loaded from file://, then the test tries every way it can to reach the
// canary. The canary must see nothing, and the browser must report no
// requests other than the page itself.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
import { OUT_FILE } from '../../build.config.js';

// ICECOLD_TEST_HTML lets a reviewer point the test at a deliberately broken
// copy to confirm the test catches leaks.
const HTML = process.env.ICECOLD_TEST_HTML || resolve(import.meta.dirname, '../..', OUT_FILE);
const PAGE_URL = pathToFileURL(HTML).href;

let canary;
let canaryHits = [];
let canaryUrl;

before(async () => {
  assert.ok(existsSync(HTML), `run "npm run build" first (${OUT_FILE} missing)`);
  canary = createServer((req, res) => { canaryHits.push(`${req.method} ${req.url}`); res.end('hit'); });
  await new Promise((r) => canary.listen(0, '127.0.0.1', r));
  canaryUrl = `http://127.0.0.1:${canary.address().port}`;
});
after(() => new Promise((r) => canary.close(r)));

for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
  describe(`built HTML in headless ${name}`, () => {
    let browser, context, page;
    const requests = [];
    const responses = [];
    const failed = new Map(); // url -> failure text
    const pageErrors = [];
    const violations = [];

    before(async () => {
      canaryHits = [];
      browser = await engine.launch();
      context = await browser.newContext({ acceptDownloads: true });
      page = await context.newPage();
      // Chromium reports a request event before CSP blocks it, then a
      // requestfailed. A request that really went out produces a response.
      page.on('request', (r) => requests.push(r.url()));
      page.on('response', (r) => responses.push(r.url()));
      page.on('requestfailed', (r) => failed.set(r.url(), r.failure()?.errorText || ''));
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (/Content.Security.Policy|CSP/i.test(m.text())) violations.push(m.text()); });
      await page.goto(PAGE_URL);
      await page.waitForFunction(() => window.__icecoldStatus !== undefined, null, { timeout: 30000 });
    });
    after(async () => { await browser?.close(); });

    test('self-test passes, code hash matches, signing enabled, lockdown complete', async () => {
      const s = await page.evaluate(() => window.__icecoldStatus);
      assert.deepEqual(s, { selfTestPassed: true, codeOk: true, signingEnabled: true, lockdownFailed: [] });
      const banner = await page.textContent('#selftest-banner');
      assert.match(banner, /Self-test passed/);
      assert.deepEqual(pageErrors, []);
    });

    test('loading the page makes zero requests besides the file itself', () => {
      // Firefox does not report the file:// navigation itself; Chromium does.
      assert.deepEqual(requests.filter((u) => u !== PAGE_URL), []);
      assert.deepEqual(responses.filter((u) => u !== PAGE_URL), []);
      assert.deepEqual(canaryHits, []);
    });

    test('network APIs are gone and Math.random is disabled', async () => {
      const r = await page.evaluate(() => ({
        fetch: typeof window.fetch,
        xhr: typeof window.XMLHttpRequest,
        ws: typeof window.WebSocket,
        es: typeof window.EventSource,
        rtc: typeof window.RTCPeerConnection,
        worker: typeof window.Worker,
        beacon: typeof navigator.sendBeacon,
        mathRandomThrows: (() => { try { Math.random(); return false; } catch { return true; } })(),
        camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      }));
      assert.deepEqual(r, {
        fetch: 'undefined', xhr: 'undefined', ws: 'undefined', es: 'undefined', rtc: 'undefined',
        worker: 'undefined', beacon: 'undefined', mathRandomThrows: true, camera: true,
      });
    });

    test('every attempt to reach the network is blocked (CSP), canary sees nothing', async () => {
      const before = requests.length;
      await page.evaluate(async (url) => {
        const events = [];
        document.addEventListener('securitypolicyviolation', (e) => events.push(e.violatedDirective));
        const add = (tag, attrs) => { const e = document.createElement(tag); Object.assign(e, attrs); document.body.append(e); return e; };
        add('img', { src: `${url}/img` });
        add('link', { rel: 'stylesheet', href: `${url}/css` });
        add('link', { rel: 'prefetch', href: `${url}/prefetch` });
        add('script', { src: `${url}/script` });
        add('iframe', { src: `${url}/iframe` });
        add('audio', { src: `${url}/audio` });
        add('video', { src: `${url}/video` });
        add('object', { data: `${url}/object` });
        const s = document.createElement('style');
        s.textContent = `body { background: url(${url}/bg); } @font-face { font-family: x; src: url(${url}/font); }`;
        document.head.append(s);
        const inline = document.createElement('script');
        inline.textContent = `document.title = 'injected inline script ran';`;
        document.body.append(inline);
        try { new Image().src = `${url}/image-obj`; } catch {}
        try { await import(`${url}/module.js`); } catch {}
        try { new window.Worker(`${url}/worker.js`); } catch {}
        const form = add('form', { action: `${url}/form`, method: 'post' });
        try { form.submit(); } catch {}
        await new Promise((r) => setTimeout(r, 1500));
        window.__violations = events;
      }, canaryUrl);
      await page.waitForTimeout(500);
      assert.deepEqual(canaryHits, [], `canary was reached: ${canaryHits.join(', ')}`);
      // Nothing got a response, and every attempt the browser reported was
      // blocked before leaving the page.
      assert.deepEqual(responses.filter((u) => u.startsWith('http')), []);
      const attempted = requests.slice(before).filter((u) => u.startsWith('http'));
      for (const u of attempted) {
        assert.ok(failed.has(u), `request was not blocked: ${u}`);
        assert.match(failed.get(u), /CSP|blocked|NS_ERROR/i, `unexpected failure for ${u}: ${failed.get(u)}`);
      }
      assert.notEqual(await page.title(), 'injected inline script ran', 'an unhashed inline script must not run');
      const v = await page.evaluate(() => window.__violations);
      assert.ok(v.length >= 5, `expected CSP violation reports, got ${JSON.stringify(v)}`);
    });

    test('CSP meta tag forbids connections and remote content', async () => {
      const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
      for (const d of ["default-src 'none'", "connect-src 'none'", "img-src 'none'", "font-src 'none'", "form-action 'none'"]) {
        assert.ok(csp.includes(d), `CSP missing ${d}`);
      }
      assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'(;|$)/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
    });

    test('a vault file can still be saved as a browser download under this CSP', async () => {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.evaluate(() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob(['{"test":true}'], { type: 'application/json' }));
          a.download = 'icecold-vault-testnet-test.json';
          document.body.append(a);
          a.click();
        }),
      ]);
      assert.equal(dl.suggestedFilename(), 'icecold-vault-testnet-test.json');
      assert.deepEqual(canaryHits, []);
    });
  });
}

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadWithMocks } = require('./helpers/load-with-mocks');

const ROOT = path.resolve(__dirname, '..');
const IMAGE_SERVICE = path.join(ROOT, 'src', 'services', 'imageService.js');

function createHarness() {
  const htmlInputs = [];
  const screenshotPaths = [];
  let launches = 0;
  let browserCloses = 0;
  let pageCloses = 0;

  const browser = {
    connected: true,
    async newPage() {
      return {
        async setViewport() {},
        async setContent(html) { htmlInputs.push(html); },
        async evaluate() { return 1080; },
        async screenshot({ path: outputPath }) { screenshotPaths.push(outputPath); },
        async close() { pageCloses += 1; },
      };
    },
    async close() { browserCloses += 1; this.connected = false; },
  };
  const puppeteer = {
    async launch() {
      launches += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return browser;
    },
  };
  const service = loadWithMocks(IMAGE_SERVICE, { puppeteer });
  const match = {
    summoner: 'Tester', champion: 'Ahri', tier: 'gold', team_result: 'WIN',
    kills: 1, deaths: 2, assists: 3, patch: '26.17',
  };

  return {
    service,
    match,
    stats: {
      htmlInputs,
      screenshotPaths,
      get launches() { return launches; },
      get browserCloses() { return browserCloses; },
      get pageCloses() { return pageCloses; },
    },
  };
}

test('동시 이미지 생성은 Puppeteer browser를 한 번만 실행하고 page는 각각 닫는다', async () => {
  const harness = createHarness();

  await Promise.all([
    harness.service.generateReportImage('## 분석\n첫 번째', harness.match),
    harness.service.generateReportImage('## 분석\n두 번째', harness.match),
  ]);

  assert.equal(harness.stats.launches, 1);
  assert.equal(harness.stats.pageCloses, 2);
  await harness.service.closeBrowser();
  assert.equal(harness.stats.browserCloses, 1);
});

test('리포트 template의 사용자 필드는 HTML escape된다', async () => {
  const harness = createHarness();
  await harness.service.generateReportImage('정상 분석', {
    ...harness.match,
    summoner: '<img src=x onerror=alert(1)>',
    champion: '<b>Ahri</b>',
  });

  const html = harness.stats.htmlInputs[0];
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;Ahri&lt;\/b&gt;/);
  await harness.service.closeBrowser();
});

test('[KNOWN DEFECT] AI 분석 text의 HTML은 escape되지 않고 template에 그대로 들어간다', async () => {
  const harness = createHarness();
  const untrusted = '<script>globalThis.injected = true</script>';

  await harness.service.generateReportImage(untrusted, harness.match);

  assert.match(harness.stats.htmlInputs[0], /<script>globalThis\.injected = true<\/script>/);
  await harness.service.closeBrowser();
});

test('[KNOWN DEFECT] 같은 millisecond의 이미지 두 장은 같은 output path를 사용한다', async (t) => {
  const harness = createHarness();
  t.mock.method(Date, 'now', () => 1234567890);

  await Promise.all([
    harness.service.generateReportImage('첫 번째', harness.match),
    harness.service.generateReportImage('두 번째', harness.match),
  ]);

  assert.equal(harness.stats.screenshotPaths.length, 2);
  assert.equal(harness.stats.screenshotPaths[0], harness.stats.screenshotPaths[1]);
  await harness.service.closeBrowser();
});

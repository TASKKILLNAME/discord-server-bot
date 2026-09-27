'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadWithMocks, withMockedModules } = require('./helpers/load-with-mocks');

const ROOT = path.resolve(__dirname, '..');

function createDashboardHarness() {
  const routes = [];
  const listenCalls = [];
  const server = {
    listeners: new Map(),
    once(event, callback) {
      this.listeners.set(event, callback);
      if (event === 'listening') queueMicrotask(callback);
      return this;
    },
    off(event) { this.listeners.delete(event); return this; },
    close(callback) { callback(); },
  };
  const app = {
    use() {},
    get(route, ...handlers) { routes.push({ method: 'GET', route, handlers }); },
    post(route, ...handlers) { routes.push({ method: 'POST', route, handlers }); },
    patch(route, ...handlers) { routes.push({ method: 'PATCH', route, handlers }); },
    delete(route, ...handlers) { routes.push({ method: 'DELETE', route, handlers }); },
    listen(port, host) { listenCalls.push({ port, host }); return server; },
  };
  const express = () => app;
  express.json = () => (_req, _res, next) => next();
  express.static = () => (_req, _res, next) => next();

  const dashboard = loadWithMocks(path.join(ROOT, 'dashboard', 'server.js'), {
    express,
    'express-session': () => (_req, _res, next) => next(),
    cors: () => (_req, _res, next) => next(),
    dotenv: { config() {} },
    axios: {},
  });

  function route(method, routePath) {
    const found = routes.find((entry) => entry.method === method && entry.route === routePath);
    assert.ok(found, `${method} ${routePath}`);
    return found;
  }

  return { dashboard, route, listenCalls };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(location) { this.redirectedTo = location; return this; },
  };
}

test('Dashboard guild API는 미로그인 요청을 401로 차단한다', () => {
  const { route } = createDashboardHarness();
  const target = route('GET', '/api/guilds/:guildId');
  const res = responseRecorder();
  let nextCalled = false;

  target.handlers[0]({ session: {} }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('Dashboard guild API는 session에 없는 guild 접근을 403으로 차단한다', () => {
  const { route } = createDashboardHarness();
  const target = route('GET', '/api/guilds/:guildId');
  const res = responseRecorder();
  let nextCalled = false;
  const req = {
    params: { guildId: 'target-guild' },
    session: { user: { guilds: [{ id: 'other-guild' }] } },
  };

  target.handlers[1](req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('로컬 Dashboard server는 127.0.0.1에 bind한다', async (t) => {
  const previousUrl = process.env.DASHBOARD_URL;
  const previousHost = process.env.DASHBOARD_HOST;
  const previousPort = process.env.DASHBOARD_PORT;
  process.env.DASHBOARD_URL = 'http://localhost:3000';
  process.env.DASHBOARD_HOST = '127.0.0.1';
  process.env.DASHBOARD_PORT = '3000';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = previousUrl;
    if (previousHost === undefined) delete process.env.DASHBOARD_HOST;
    else process.env.DASHBOARD_HOST = previousHost;
    if (previousPort === undefined) delete process.env.DASHBOARD_PORT;
    else process.env.DASHBOARD_PORT = previousPort;
  });
  t.mock.method(console, 'log', () => {});
  const harness = createDashboardHarness();

  await harness.dashboard.startDashboard({});

  assert.deepEqual(harness.listenCalls, [{ port: '3000', host: '127.0.0.1' }]);
});

test('[KNOWN DEFECT] Dashboard 수동 패치 API는 존재하지 않는 patchScheduler module로 500을 반환한다', async () => {
  const { dashboard, route } = createDashboardHarness();
  dashboard.setBotClient({
    guilds: {
      cache: new Map([['g1', { channels: { cache: new Map([['c1', {}]]) } }]]),
    },
  });
  const handler = route('POST', '/api/guilds/:guildId/patchnotes/check').handlers.at(-1);
  const req = { params: { guildId: 'g1' }, body: { channelId: 'c1' } };
  const res = responseRecorder();

  await withMockedModules({
    '../src/services/patchCrawler': {
      forceGetLatestPatch: async () => ({ title: '테스트 패치', url: 'https://example.test' }),
    },
  }, () => handler(req, res));

  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /patchScheduler|Cannot find module/);
});

test('[KNOWN DEFECT] Dashboard 패치 상태 API는 async 결과를 await하지 않아 상태 필드가 빠진다', async () => {
  const { route } = createDashboardHarness();
  const handler = route('GET', '/api/patchnotes/status').handlers.at(-1);
  const res = responseRecorder();

  await withMockedModules({
    '../src/services/patchCrawler': {
      loadLastPatch: async () => ({ lastUrl: 'https://example.test/patch', lastTitle: '테스트 패치' }),
    },
  }, () => handler({}, res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lastUrl, undefined);
  assert.equal(res.body.lastTitle, undefined);
});

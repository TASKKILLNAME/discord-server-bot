'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'src', 'commands');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      return walk(target);
    }
    return entry.isFile() ? [target] : [];
  });
}

test('모든 slash command module이 로드되고 이름이 중복되지 않는다', () => {
  const files = fs.readdirSync(COMMANDS_DIR).filter((name) => name.endsWith('.js'));
  const commands = files.map((name) => {
    const command = require(path.join(COMMANDS_DIR, name));
    assert.equal(typeof command.execute, 'function', `${name}: execute`);
    assert.equal(typeof command.data?.toJSON, 'function', `${name}: data`);
    return { file: name, json: command.data.toJSON() };
  });

  const names = commands.map(({ json }) => json.name);
  assert.equal(new Set(names).size, names.length, 'slash command 이름 중복');

  for (const { file, json } of commands) {
    assert.ok(json.name, `${file}: command name`);
    if (!json.type || json.type === 1) {
      assert.ok(json.description, `${file}: command description`);
    }
    const subcommands = (json.options || []).filter((option) => option.type === 1);
    const subcommandNames = subcommands.map((option) => option.name);
    assert.equal(new Set(subcommandNames).size, subcommandNames.length, `${file}: subcommand 중복`);
  }
});

test('[KNOWN DEFECT] source의 정적 local require 중 dashboard patchScheduler 하나가 해석되지 않는다', () => {
  const sourceFiles = walk(ROOT).filter((file) =>
    file.endsWith('.js') && !file.includes(`${path.sep}tests${path.sep}`)
  );
  const missing = [];
  const requirePattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const localRequire = Module.createRequire(file);
    for (const match of source.matchAll(requirePattern)) {
      try {
        localRequire.resolve(match[1]);
      } catch {
        missing.push(`${path.relative(ROOT, file).replaceAll('\\', '/')} -> ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing.sort(), [
    'dashboard/server.js -> ../src/services/patchScheduler',
  ]);
});

test('필수 환경변수 예제와 로컬 검사 목록이 일치한다', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'DATABASE_URL', 'SESSION_SECRET'];
  for (const key of required) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), key);
  }
});

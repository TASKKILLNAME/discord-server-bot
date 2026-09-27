const fs = require('fs');
const path = require('path');
const util = require('util');

const projectRoot = path.resolve(__dirname, '..');

function writeStartupFailure(error) {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const logDirectory = path.join(projectRoot, 'logs');
  const logPath = path.join(logDirectory, `bot-${date}.log`);
  const message = error?.stack || util.format(error);

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(logPath, `[${now.toISOString()}] [fatal] 초기 모듈 로딩 실패: ${message}\n`);
  } catch (logError) {
    process.stderr.write(`로컬 로그 기록 실패: ${util.format(logError)}\n`);
  }

  process.stderr.write(`초기 모듈 로딩 실패: ${message}\n`);
}

try {
  require(path.join(projectRoot, 'src', 'index.js'));
} catch (error) {
  writeStartupFailure(error);
  process.exit(1);
}

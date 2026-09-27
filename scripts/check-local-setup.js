const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const errors = [];
const warnings = [];

function isConfigured(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !/^(여기에_|change-me|replace-me|<.+>)/i.test(value.trim());
}

const [nodeMajor, nodeMinor] = process.versions.node
  .split('.')
  .map((part) => Number.parseInt(part, 10));
const supportedNode = (nodeMajor === 18 && nodeMinor >= 17)
  || (nodeMajor === 20 && nodeMinor >= 3)
  || nodeMajor >= 21;
if (!supportedNode) {
  errors.push(`지원되는 Node.js 버전이 아닙니다. 현재 버전: ${process.version}`);
}

let fileEnvironment = {};
if (!fs.existsSync(envPath)) {
  errors.push('.env 파일이 없습니다. .env.example을 복사한 뒤 값을 입력하세요.');
} else {
  fileEnvironment = dotenv.parse(fs.readFileSync(envPath));
}

const environment = { ...fileEnvironment, ...process.env };
const required = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'DATABASE_URL',
  'SESSION_SECRET',
];
for (const name of required) {
  if (!isConfigured(environment[name])) errors.push(`${name}이(가) 설정되지 않았습니다.`);
}

if (isConfigured(environment.DATABASE_URL)) {
  if (environment.DATABASE_URL === 'postgresql://USER:PASSWORD@HOST:5432/DATABASE') {
    errors.push('DATABASE_URL의 예시 값을 실제 PostgreSQL 접속 주소로 바꾸세요.');
  } else if (environment.DATABASE_URL.includes('railway.internal')) {
    errors.push('DATABASE_URL이 Railway 내부 주소입니다. 로컬에서는 public PostgreSQL URL이 필요합니다.');
  } else if (!/^postgres(?:ql)?:\/\//i.test(environment.DATABASE_URL)) {
    errors.push('DATABASE_URL은 postgresql:// 또는 postgres:// 형식이어야 합니다.');
  }
}

if (isConfigured(environment.SESSION_SECRET) && environment.SESSION_SECRET.length < 32) {
  warnings.push('SESSION_SECRET은 32자 이상의 임의 문자열을 권장합니다.');
}

for (const name of ['CLIENT_ID', 'GUILD_ID', 'BOT_OWNER_ID']) {
  if (isConfigured(environment[name]) && !/^\d+$/.test(environment[name].trim())) {
    warnings.push(`${name} 값이 Discord 숫자 ID 형식이 아닙니다.`);
  }
}

if (isConfigured(environment.DASHBOARD_URL)) {
  try {
    const hostname = new URL(environment.DASHBOARD_URL).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      warnings.push('DASHBOARD_URL이 localhost가 아닙니다. 이전 호스팅 주소라면 로컬 주소로 바꾸세요.');
    }
  } catch {
    errors.push('DASHBOARD_URL이 올바른 URL 형식이 아닙니다.');
  }

  if (/\/$/.test(environment.DASHBOARD_URL.trim())) {
    warnings.push('DASHBOARD_URL 끝의 /는 실행 시 자동으로 제거됩니다.');
  }
}

if (['0.0.0.0', '::', '[::]'].includes(environment.DASHBOARD_HOST?.trim())) {
  warnings.push('DASHBOARD_HOST가 모든 네트워크에 공개됩니다. 로컬 전용이면 127.0.0.1을 사용하세요.');
}

for (const dependency of ['discord.js', 'pg', 'puppeteer', 'sharp']) {
  try {
    require.resolve(dependency, { paths: [projectRoot] });
  } catch {
    errors.push(`${dependency} 의존성이 없습니다. npm ci를 실행하세요.`);
  }
}

console.log(`Node.js ${process.version}`);
console.log(fs.existsSync(envPath) ? '.env 파일 확인 완료' : '.env 파일 없음');

for (const warning of warnings) console.warn(`⚠️ ${warning}`);
for (const error of errors) console.error(`❌ ${error}`);

if (errors.length > 0) {
  console.error(`\n로컬 실행 준비 실패: 오류 ${errors.length}개`);
  process.exit(1);
}

console.log('\n✅ 로컬 실행에 필요한 기본 설정이 준비되었습니다.');

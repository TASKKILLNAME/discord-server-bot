'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const action = process.argv[2];
function run(command, args, optional = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (!optional && (result.error || result.status !== 0)) {
    throw result.error || new Error(`${command} exited with ${result.status}`);
  }
  return result.status;
}
try {
  if (process.platform === 'win32') {
    const script = action === 'db:install' ? 'install-local-postgres.ps1' : 'local-bot.ps1';
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...(action === 'db:install' ? [] : [action])]);
  } else if (process.platform === 'darwin') {
    const label = 'local.discord-server-manager-bot';
    const target = `gui/${process.getuid()}/${label}`;
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const install = () => {
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
      fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, 'scripts/local-runner.js'))}</string><string>--local-task</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>60</integer>
<key>StandardOutPath</key><string>${xml(path.join(root, 'logs/launchd.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(root, 'logs/launchd.stderr.log'))}</string>
</dict></plist>\n`, { mode: 0o600 });
      run('plutil', ['-lint', plist]);
      console.log('로그인 자동 시작 설정 작성 완료. 지금 실행: npm run local:start');
    };
    switch (action) {
      case 'install': install(); break;
      case 'start': {
        if (!fs.existsSync(plist)) install();
        // A stop marker copied from Windows must not stop a new Mac instance.
        fs.rmSync(path.join(root, 'logs/local-bot.stop'), { force: true });
        const loaded = spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
        if (!loaded) run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
        run('launchctl', ['kickstart', target]);
        break;
      }
      case 'stop': run('launchctl', ['bootout', target], true); break;
      case 'status': run('launchctl', ['print', target], true); break;
      case 'uninstall':
        run('launchctl', ['bootout', target], true);
        fs.rmSync(plist, { force: true });
        break;
      case 'db:install':
        run('brew', ['install', 'postgresql@16']);
        run('brew', ['services', 'start', 'postgresql@16']);
        console.log('PostgreSQL 준비 완료. .env DATABASE_URL에 맞는 DB와 role이 별도로 필요합니다.');
        break;
      default: throw new Error('지원 명령: install, start, stop, status, uninstall, db:install');
    }
  } else {
    throw new Error('이 로컬 서비스 도구는 Windows와 macOS를 지원합니다. 다른 OS에서는 npm start를 사용하세요.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

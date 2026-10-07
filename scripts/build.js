// 打包脚本：node scripts/build.js [rpa|api]
// 同一套代码打成两个独立安装包：RPA 版（默认，操作桌面客户端发客户群）和接口版（企业微信客户群群发接口）。
// 版本写进打包后的 package.json（edition 字段）和界面（__TRAVELBOT_EDITION__），两版只显示各自的功能。
const { execSync } = require('node:child_process');
const builder = require('electron-builder');
const pkg = require('../package.json');

const edition = process.argv[2] === 'api' ? 'api' : 'rpa';
const label = edition === 'api' ? 'API' : 'RPA';
const run = command => execSync(command, { stdio: 'inherit', env: { ...process.env, TRAVELBOT_EDITION: edition } });

run('npx tsc -p tsconfig.json');
run('npx vite build');
builder.build({
  targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
  config: {
    ...pkg.build,
    extraMetadata: { edition },
    win: { ...pkg.build.win, artifactName: `TravelBot-${label}-Setup-\${version}.\${ext}` },
  },
}).then(files => console.log(`\n${label} 版安装包：\n${files.join('\n')}`), error => { console.error(error); process.exit(1); });

# TravelBot Windows EXE V0.1

Electron + React + TypeScript PoC for the real `@wecom/cli` flow:

1. `wecom-cli auth init --noninteractive --no-browser --output-qrcode ...`
2. `wecom-cli auth show --status`
3. `wecom-cli identity whoami`
4. `wecom-cli message aibot send --json ...`

## Build and run

Requires Node.js 18+ and Windows x64. `npm install` installs the official CLI and its Windows binary.

```powershell
npm install
npm run typecheck
npm run dev
npm run build
```

The installer is generated under `dist/TravelBot-Setup-0.1.0.exe`. The app stores the CLI credential directory under the Windows app data directory and never displays or logs the credential contents.

The test message is sent to the identity returned by the official CLI. This respects wecom-cli's rule that the target must be the authorized user or a current permitted session.

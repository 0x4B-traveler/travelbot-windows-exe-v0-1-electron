import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// TRAVELBOT_EDITION 由 scripts/build.js 设置：rpa（默认）或 api，界面按版本只显示对应的发送方式。
const edition = process.env.TRAVELBOT_EDITION === 'api' ? 'api' : 'rpa';

export default defineConfig({ base: './', plugins: [react()], build: { outDir: 'dist' }, define: { __TRAVELBOT_EDITION__: JSON.stringify(edition) } });

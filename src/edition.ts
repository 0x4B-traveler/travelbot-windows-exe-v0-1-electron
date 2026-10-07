import type { Edition } from './domain/ops';

declare const __TRAVELBOT_EDITION__: Edition;
/** 界面所属的版本，由 vite.config.ts 在打包时注入。 */
export const EDITION: Edition = __TRAVELBOT_EDITION__ === 'api' ? 'api' : 'rpa';

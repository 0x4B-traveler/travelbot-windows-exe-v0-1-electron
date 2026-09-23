/// <reference types="vite/client" />
declare global {
  interface Window { travelbot: { authStatus(): Promise<CliResult>; listGroups(): Promise<{ ok: boolean; groups: Array<{ id?: string; name: string; lastTime?: string }>; stderr?: string }>; getSettings(): Promise<ScheduleSettings>; saveSchedule(settings: ScheduleInput): Promise<{ ok: boolean; stderr?: string; settings?: ScheduleSettings }>; startAuth(): Promise<CliResult & { pending?: boolean; qrcode?: string | null }>; sendTest(content: string, groupIds: string[]): Promise<CliResult>; openImage(path: string): Promise<boolean>; }; }
  interface ScheduleInput { enabled: boolean; groupIds: string[]; groupNames: string[]; intervalMinutes: number; message: string; }
  interface ScheduleSettings extends ScheduleInput { chatIds: string[]; lastRun?: string; lastResult?: string; }
  interface CliResult { ok: boolean; stdout?: string; stderr?: string; step?: string; pending?: boolean; }
}
export {};

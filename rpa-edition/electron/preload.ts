import { contextBridge, ipcRenderer } from 'electron';
import type { DailyPushSettings, ItineraryItem, ItinerarySettings } from '../src/domain/business';

// 运营模块统一走 ops:invoke（界面 → API → Service），方法名白名单在主进程 api/ops-ipc.ts。
contextBridge.exposeInMainWorld('opsApi', {
  invoke: (method: string, args?: unknown) => ipcRenderer.invoke('ops:invoke', method, args),
});

// 行程提醒、每日推送两个任务来源。
contextBridge.exposeInMainWorld('travelbot', {
  openImage: (path: string) => ipcRenderer.invoke('open-image', path),
  dailyPush: () => ipcRenderer.invoke('daily-get'),
  saveDailyPush: (input: DailyPushSettings) => ipcRenderer.invoke('daily-save', input),
  previewDailyPush: (input?: DailyPushSettings) => ipcRenderer.invoke('daily-preview', input),
  runDailyPush: () => ipcRenderer.invoke('daily-run'),
  itinerary: () => ipcRenderer.invoke('itinerary-get'),
  saveItinerarySettings: (input: ItinerarySettings) => ipcRenderer.invoke('itinerary-save-settings', input),
  parseItinerary: (text: string) => ipcRenderer.invoke('itinerary-parse', text),
  importItinerary: (input: { text: string; mode: 'append' | 'replace' }) => ipcRenderer.invoke('itinerary-import', input),
  updateItineraryItem: (input: { id: string; patch: Partial<Pick<ItineraryItem, 'separate'>> }) => ipcRenderer.invoke('itinerary-update-item', input),
  deleteItineraryItems: (input: { ids?: string[]; groupName?: string; beforeToday?: boolean }) => ipcRenderer.invoke('itinerary-delete-items', input),
  previewItineraryJob: (jobId: string) => ipcRenderer.invoke('itinerary-preview-job', jobId),
  runItineraryJob: (jobId: string) => ipcRenderer.invoke('itinerary-run-job', jobId),
});

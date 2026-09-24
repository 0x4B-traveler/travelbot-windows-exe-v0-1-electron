import { contextBridge, ipcRenderer } from 'electron';
import type { ContentKind, NaturalLanguageCommand, WeatherJobSettings } from '../src/domain/business';

contextBridge.exposeInMainWorld('travelbot', {
  authStatus: () => ipcRenderer.invoke('auth-status'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSchedule: (settings: { enabled: boolean; groupIds: string[]; groupNames: string[]; intervalMinutes: number; message: string }) => ipcRenderer.invoke('save-schedule', settings),
  listGroups: () => ipcRenderer.invoke('list-groups'),
  startAuth: () => ipcRenderer.invoke('auth-start'),
  sendTest: (content: string, groupIds: string[]) => ipcRenderer.invoke('send-test', content, groupIds),
  openImage: (path: string) => ipcRenderer.invoke('open-image', path),
  weatherPreview: (location: string) => ipcRenderer.invoke('weather-preview', location),
  contentSearch: (input: { query: string; kind?: ContentKind }) => ipcRenderer.invoke('content-search', input),
  contentCommand: (text: string) => ipcRenderer.invoke('content-command', text),
  contentConfirm: (input: { command: NaturalLanguageCommand; confirmed: boolean }) => ipcRenderer.invoke('content-confirm', input),
  getWeatherJob: () => ipcRenderer.invoke('get-weather-job'),
  saveWeatherJob: (input: Omit<WeatherJobSettings, 'id' | 'lastSentAt' | 'lastResult'>) => ipcRenderer.invoke('save-weather-job', input),
  runWeatherJob: () => ipcRenderer.invoke('run-weather-job'),
});

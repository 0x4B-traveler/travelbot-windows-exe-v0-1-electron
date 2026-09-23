import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('travelbot', {
  authStatus: () => ipcRenderer.invoke('auth-status'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSchedule: (settings: { enabled: boolean; groupIds: string[]; groupNames: string[]; intervalMinutes: number; message: string }) => ipcRenderer.invoke('save-schedule', settings),
  listGroups: () => ipcRenderer.invoke('list-groups'),
  startAuth: () => ipcRenderer.invoke('auth-start'),
  sendTest: (content: string, groupIds: string[]) => ipcRenderer.invoke('send-test', content, groupIds),
  openImage: (path: string) => ipcRenderer.invoke('open-image', path),
});

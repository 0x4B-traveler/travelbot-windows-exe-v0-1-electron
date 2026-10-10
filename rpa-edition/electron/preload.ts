import { contextBridge, ipcRenderer } from 'electron';

// 界面只通过 ops:invoke 调用主进程（界面 → API → Service），方法名白名单在主进程 api/ops-ipc.ts。
contextBridge.exposeInMainWorld('opsApi', {
  invoke: (method: string, args?: unknown) => ipcRenderer.invoke('ops:invoke', method, args),
});

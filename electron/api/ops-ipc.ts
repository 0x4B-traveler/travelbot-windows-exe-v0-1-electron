import { ipcMain } from 'electron';
import type { OpsApi, OpsMethod, OpsResponse } from '../../src/domain/ops';
import { OpsError, type ContentService, type DashboardService, type GroupService, type LogService, type MaterialService, type RouteService, type SendSettingsService, type TaskService } from '../application/services';

// API 层：界面只能通过这一个 IPC 通道调用 Service，不能直接访问 SQLite、企业微信或大模型。
export type OpsServices = { dashboard: DashboardService; materials: MaterialService; routes: RouteService; contents: ContentService; tasks: TaskService; groups: GroupService; logs: LogService; sendSettings: SendSettingsService };

export function registerOpsApi(services: OpsServices) {
  const { dashboard, materials, routes, contents, tasks, groups, logs, sendSettings } = services;
  const handlers: { [K in OpsMethod]: (args: any) => ReturnType<OpsApi[K]> | Awaited<ReturnType<OpsApi[K]>> } = {
    'dashboard.get': () => dashboard.get(),

    'material.list': query => materials.list(query ?? {}),
    'material.facets': () => materials.facets(),
    'material.save': input => materials.save(input),
    'material.delete': ({ id }) => materials.delete(id),
    'material.import': ({ text }) => materials.import(String(text ?? '')),
    'material.addImages': ({ id }) => materials.addImages(id),
    'material.removeImage': ({ id, imageId }) => materials.removeImage(id, imageId),
    'material.imageData': ({ imageId }) => materials.imageData(imageId),

    'route.list': query => routes.list(query ?? {}),
    'route.save': input => routes.save(input),
    'route.delete': ({ id }) => routes.delete(id),

    'content.list': query => contents.list(query?.status),
    'content.versions': ({ id }) => contents.versions(id),
    'content.save': input => contents.save(input),
    'content.generate': input => contents.generate(input),
    'content.regenerate': ({ id }) => contents.regenerate(id),
    'content.submit': ({ id }) => contents.submit(id),
    'content.approve': ({ id }) => contents.approve(id),
    'content.reject': ({ id }) => contents.reject(id),
    'content.delete': ({ id }) => contents.delete(id),

    'task.list': query => tasks.list(query?.status),
    'task.create': input => tasks.create(input),
    'task.cancel': ({ id }) => tasks.cancel(id),
    'task.retry': ({ id }) => tasks.retry(id),
    'task.runNow': ({ id }) => tasks.runNow(id),
    'task.delete': ({ id }) => tasks.delete(id),
    'task.runs': ({ id }) => tasks.runs(id),
    'task.dryRun': input => tasks.dryRun(input),

    'group.list': () => groups.list(),
    'group.refresh': () => groups.refresh(),
    'group.update': input => groups.update(input),
    'group.testSend': ({ id, text }) => groups.testSend(id, String(text ?? '')),
    'group.add': ({ names, accountId }) => groups.add(names, accountId),
    'group.delete': ({ id }) => groups.delete(id),

    'settings.getSend': () => sendSettings.get(),
    'settings.saveSend': input => sendSettings.save(input),
    'settings.checkRpa': ({ rpa }) => sendSettings.checkRpa(rpa),
    'settings.checkAccount': ({ account }) => sendSettings.checkAccount(account),
    'settings.agentInfo': () => sendSettings.agent(),

    'log.list': query => logs.list(query ?? {}),
  };

  ipcMain.handle('ops:invoke', async (_event, method: string, args: unknown): Promise<OpsResponse<unknown>> => {
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) return { ok: false, error: `未知操作：${method}` };
    try {
      return { ok: true, data: await handlers[method as OpsMethod]((args ?? {}) as any) };
    } catch (error: any) {
      if (!(error instanceof OpsError)) logs.write({ module: 'System', action: method, status: 'fail', message: error?.message || String(error), detail: error?.stack });
      return { ok: false, error: error?.message || '操作失败' };
    }
  });
}

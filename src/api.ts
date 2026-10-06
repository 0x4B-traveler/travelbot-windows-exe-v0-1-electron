import type { OpsApi, OpsMethod } from './domain/ops';

// 界面调用主进程 Service 的唯一入口。失败时抛出带中文说明的 Error，页面负责展示。
export async function call<M extends OpsMethod>(method: M, ...args: Parameters<OpsApi[M]>): Promise<Awaited<ReturnType<OpsApi[M]>>> {
  const response = await window.opsApi.invoke(method, args[0]);
  if (!response.ok) throw new Error(response.error);
  return response.data as Awaited<ReturnType<OpsApi[M]>>;
}

export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function formatTime(iso?: string, withDate = true) {
  if (!iso) return '';
  const date = new Date(iso);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return withDate ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}` : time;
}

/** datetime-local 输入框需要的本地时间字符串。 */
export function toLocalInput(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

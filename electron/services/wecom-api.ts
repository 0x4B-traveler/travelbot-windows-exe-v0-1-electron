import type { CustomerGroup, GroupMessageResult, GroupMessageSendItem } from '../../src/domain/business';

// 企业微信服务端接口：客户群群发助手（externalcontact/add_msg_template，chat_type=group）。
// 文档：https://developer.work.weixin.qq.com/document/path/92135
const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_EXPIRED_CODES = new Set([40014, 42001]);

export type WeComApiCredentials = { corpId: string; secret: string };

type ApiBody = { errcode?: number; errmsg?: string; [key: string]: any };

export class WeComApiError extends Error {
  constructor(readonly errcode: number, errmsg: string, readonly path: string) {
    super(`${describeErrcode(errcode, errmsg)}（${path} errcode=${errcode}）`);
  }
}

export class WeComCustomerGroupApi {
  private token: { value: string; expiresAt: number; key: string } | null = null;

  constructor(private readonly credentials: () => WeComApiCredentials | null) {}

  /** 清除缓存的 access_token，配置变更后调用。 */
  reset() { this.token = null; }

  async listCustomerGroups(ownerUserIds: string[]): Promise<CustomerGroup[]> {
    const chatIds: string[] = [];
    let cursor = '';
    do {
      const body = await this.post('/externalcontact/groupchat/list', {
        status_filter: 0,
        ...(ownerUserIds.length ? { owner_filter: { userid_list: ownerUserIds } } : {}),
        cursor,
        limit: 1000,
      });
      for (const item of body.group_chat_list ?? []) if (item?.chat_id) chatIds.push(item.chat_id);
      cursor = body.next_cursor || '';
    } while (cursor);

    return mapWithConcurrency(chatIds, 5, async chatId => {
      const body = await this.post('/externalcontact/groupchat/get', { chat_id: chatId, need_name: 1 });
      const chat = body.group_chat ?? {};
      return { chatId, name: chat.name || '未命名客户群', owner: chat.owner || '', memberCount: Array.isArray(chat.member_list) ? chat.member_list.length : 0 };
    });
  }

  /** 创建客户群群发任务。任务会推送给 sender，由其在企业微信中确认后发出。 */
  async createGroupMessage(input: { sender: string; chatIds: string[]; content: string }): Promise<{ msgid: string; failList: string[] }> {
    const body = await this.post('/externalcontact/add_msg_template', {
      chat_type: 'group',
      sender: input.sender,
      chat_id_list: input.chatIds,
      text: { content: input.content },
    });
    return { msgid: body.msgid, failList: Array.isArray(body.fail_list) ? body.fail_list : [] };
  }

  /** 查询群发任务的确认状态与各客户群的发送结果。 */
  async getGroupMessageResult(msgid: string): Promise<GroupMessageResult> {
    const tasks: Array<{ userid: string; status: number; sendTime?: number }> = [];
    let cursor = '';
    do {
      const body = await this.post('/externalcontact/get_groupmsg_task', { msgid, limit: 1000, cursor });
      for (const task of body.task_list ?? []) tasks.push({ userid: task.userid, status: task.status, sendTime: task.send_time });
      cursor = body.next_cursor || '';
    } while (cursor);

    const sends: GroupMessageSendItem[] = [];
    for (const task of tasks) {
      let sendCursor = '';
      do {
        const body = await this.post('/externalcontact/get_groupmsg_send_result', { msgid, userid: task.userid, limit: 1000, cursor: sendCursor });
        for (const item of body.send_list ?? []) sends.push({ chatId: item.chat_id || item.external_userid || '', userid: item.userid, status: item.status, sendTime: item.send_time });
        sendCursor = body.next_cursor || '';
      } while (sendCursor);
    }
    return { msgid, tasks, sends };
  }

  private async post(path: string, payload: unknown, retried = false): Promise<ApiBody> {
    const token = await this.accessToken();
    const body = await requestJson(`${API_BASE}${path}?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (body.errcode && TOKEN_EXPIRED_CODES.has(body.errcode) && !retried) {
      this.token = null;
      return this.post(path, payload, true);
    }
    if (body.errcode) throw new WeComApiError(body.errcode, body.errmsg || '', path);
    return body;
  }

  private async accessToken(): Promise<string> {
    const credentials = this.credentials();
    if (!credentials?.corpId || !credentials.secret) throw new Error('请先在“客户群群发”中配置企业 ID 和客户联系 Secret');
    const key = `${credentials.corpId}:${credentials.secret}`;
    if (this.token && this.token.key === key && Date.now() < this.token.expiresAt) return this.token.value;
    const body = await requestJson(`${API_BASE}/gettoken?corpid=${encodeURIComponent(credentials.corpId)}&corpsecret=${encodeURIComponent(credentials.secret)}`);
    if (body.errcode) throw new WeComApiError(body.errcode, body.errmsg || '', '/gettoken');
    // 提前 5 分钟过期，避免边界时刻使用失效 token
    this.token = { value: body.access_token, key, expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 7200) - 300) * 1000 };
    return this.token.value;
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<ApiBody> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch (error: any) {
    throw new Error(`无法连接企业微信服务器：${error?.message || '网络错误'}`);
  }
  if (!response.ok) throw new Error(`企业微信服务器返回 HTTP ${response.status}`);
  try { return await response.json() as ApiBody; } catch { throw new Error('企业微信接口返回了无法解析的 JSON'); }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index]); }
  });
  await Promise.all(runners);
  return results;
}

function describeErrcode(errcode: number, errmsg: string): string {
  switch (errcode) {
    case 40001: case 40013: case 40091: return '企业 ID 或 Secret 不正确';
    case 60020: return '当前电脑的公网 IP 不在企业可信 IP 列表中，请在管理后台添加';
    case 48002: return 'Secret 没有该接口权限，请使用“客户联系”Secret 或为自建应用开通客户联系权限';
    case 41063: return '群发消息正在发送中，请稍后再查询';
    default: return errmsg || '企业微信接口调用失败';
  }
}

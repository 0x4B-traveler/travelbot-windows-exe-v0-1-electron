import type { AccountStatus, ContentChannel, Material, Route, RpaSettings, SendSettings } from '../../src/domain/ops';
import type { RpaSendContext, RpaSendResult } from './rpa-executor';

// Application 层依赖的外部能力（端口）。具体实现放在 Infrastructure，由 main.ts 组装注入，
// 这样以后把企业微信换成官方接口 / UI 自动化，或者把模板生成换成大模型，都不用动业务服务。

/** 智能机器人所在的群聊（wecom-cli），消息直接发出。 */
export interface BotGateway {
  listGroups(): Promise<Array<{ chatId: string; name: string }>>;
  sendText(chatId: string, text: string): Promise<void>;
}

/** 客户群群发助手（企业微信服务端接口），创建任务后需群主确认。 */
export interface CustomerGroupGateway {
  configured(): boolean;
  defaultSender(): string;
  listGroups(owners: string[]): Promise<Array<{ chatId: string; name: string; owner: string; memberCount: number }>>;
  createGroupMessage(input: { sender: string; chatIds: string[]; content: string }): Promise<{ msgid: string; failList: string[] }>;
}

/** 桌面客户端 RPA：在本机企业微信 / 微信里按群名搜索并发送，不需要接口权限和可信 IP。 */
export interface DesktopRpaGateway {
  /** 只检查能否找到客户端窗口，不发送。override 用于保存前先试一下界面上的设置。 */
  check(override?: RpaSettings): Promise<string>;
  /** 先发文字，再逐张发图片（本机文件路径）。sent=false 表示按设置只粘贴到了输入框，等人工按发送。 */
  sendText(groupName: string, text: string, images?: string[]): Promise<{ sent: boolean }>;
}

/** 账号池里一个账号的发送入口（本机执行器或局域网执行端），防封规则在执行的那台电脑上计算。 */
export interface RpaAccountClient {
  check(groupName?: string): Promise<AccountStatus>;
  send(groupName: string, text: string, images: string[], context: RpaSendContext): Promise<RpaSendResult>;
}

export interface SendSettingsStore {
  get(): SendSettings;
  save(settings: SendSettings): void;
}

export interface WeatherGateway {
  /** 返回一行可直接拼进消息的天气预报文字。 */
  forecastLine(city: string, date: Date): Promise<string>;
}

export interface FileStore {
  /** 把用户选择的文件复制进应用数据目录，返回保存后的路径。 */
  importFile(sourcePath: string): string;
  dataUrl(path: string): string | null;
  remove(path: string): void;
}

export interface FilePicker {
  pickImages(): Promise<string[]>;
}

export type GeneratedContent = { title: string; body: string };

export interface ContentGenerator {
  readonly source: 'ai' | 'template';
  /** variant 用于“重新生成”时换一种写法。 */
  generate(input: { route: Route; materials: Material[]; channel: ContentChannel; variant: number }): Promise<GeneratedContent>;
}

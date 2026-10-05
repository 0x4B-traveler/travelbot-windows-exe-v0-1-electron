export type ContentKind = 'guide' | 'route' | 'spot' | 'restaurant' | 'hotel';

export type ContentItem = {
  id: string;
  kind: ContentKind;
  title: string;
  body: string;
  location?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type WeatherSnapshot = {
  location: string;
  latitude: number;
  longitude: number;
  temperatureC: number;
  apparentTemperatureC?: number;
  humidity?: number;
  precipitationMm?: number;
  windSpeedKmh?: number;
  weatherCode: number;
  observedAt: string;
};

export type WeatherGreeting = {
  title: string;
  message: string;
  snapshot: WeatherSnapshot;
};

export type WeatherJobSettings = {
  id: string;
  location: string;
  chatIds: string[];
  intervalMinutes: number;
  enabled: boolean;
  lastSentAt?: string;
  lastResult?: string;
};

export type NaturalLanguageCommand =
  | { intent: 'search'; query: string }
  | { intent: 'create'; kind: ContentKind; title: string; body: string; requiresConfirmation: true }
  | { intent: 'update'; query: string; body: string; requiresConfirmation: true }
  | { intent: 'delete'; query: string; requiresConfirmation: true }
  | { intent: 'unknown'; reason: string };

export type CustomerGroup = {
  chatId: string;
  name: string;
  owner: string;
  memberCount: number;
};

/** 渲染进程可见的群发配置，不包含 Secret 明文。 */
export type GroupMessageConfigView = {
  corpId: string;
  senderUserId: string;
  hasSecret: boolean;
  encryptionAvailable: boolean;
};

export type GroupMessageConfigInput = {
  corpId: string;
  senderUserId: string;
  /** 留空表示保留已保存的 Secret */
  secret?: string;
};

export type GroupMessageSendItem = {
  chatId: string;
  userid: string;
  /** 0 未发送 1 已发送 2/3 发送失败 */
  status: number;
  sendTime?: number;
};

export type GroupMessageResult = {
  msgid: string;
  /** status：0 未确认 2 已确认发送 */
  tasks: Array<{ userid: string; status: number; sendTime?: number }>;
  sends: GroupMessageSendItem[];
};

export type GroupMessageRecord = {
  msgid: string;
  createdAt: string;
  sender: string;
  chatIds: string[];
  content: string;
  source: 'manual' | 'schedule';
};

export type WeatherForecast = {
  location: string;
  /** 本地日期 YYYY-MM-DD */
  date: string;
  weatherCode: number;
  maxC: number;
  minC: number;
  precipitationProbability?: number;
};

/** 每日客户群推送：每天固定时刻生成“天气预报 + 今日推荐”，按群主各创建一个群发任务。 */
export type DailyPushTarget = { chatId: string; owner: string; name: string };

export type DailyPushSettings = {
  enabled: boolean;
  /** 本地时间 HH:mm */
  sendTime: string;
  includeWeather: boolean;
  location: string;
  includeRecommendation: boolean;
  /** 附加在消息末尾的固定文字，可留空 */
  footer: string;
  /** 群主 userid，客户群列表按这些群主加载 */
  ownerUserIds: string[];
  targets: DailyPushTarget[];
  launchAtLogin: boolean;
};

export type DailyPushState = {
  /** 最近一次成功处理的本地日期 YYYY-MM-DD */
  lastRunDate?: string;
  /** 当天已成功创建任务的群主，用于部分失败时只重试剩余群主 */
  doneOwners: string[];
  attemptDate?: string;
  attempts: number;
  lastAttemptAt?: string;
  lastRecommendationId?: string;
  lastResult?: string;
};

export type DailyPushView = DailyPushSettings & { state: DailyPushState; nextRunAt?: string };

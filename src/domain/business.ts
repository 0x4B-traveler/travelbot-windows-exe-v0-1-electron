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

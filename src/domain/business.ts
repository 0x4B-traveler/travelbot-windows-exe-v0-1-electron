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

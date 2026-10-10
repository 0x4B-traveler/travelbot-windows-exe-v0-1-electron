import type { WeatherForecast, WeatherGreeting, WeatherSnapshot } from '../../src/domain/business';

export interface WeatherProvider {
  getCurrent(location: string): Promise<WeatherSnapshot>;
}

type GeocodeResult = { name: string; latitude: number; longitude: number };

export class OpenMeteoWeatherProvider implements WeatherProvider {
  async getCurrent(location: string): Promise<WeatherSnapshot> {
    const place = await this.geocode(location);
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(place.latitude));
    url.searchParams.set('longitude', String(place.longitude));
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code');
    url.searchParams.set('timezone', 'auto');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`天气服务暂时不可用（HTTP ${response.status}）`);
    const payload = await response.json() as { current?: Record<string, number | string> };
    const current = payload.current;
    if (!current) throw new Error('天气服务未返回当前天气');
    return {
      location: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      temperatureC: Number(current.temperature_2m),
      apparentTemperatureC: Number(current.apparent_temperature),
      humidity: Number(current.relative_humidity_2m),
      precipitationMm: Number(current.precipitation),
      windSpeedKmh: Number(current.wind_speed_10m),
      weatherCode: Number(current.weather_code),
      observedAt: String(current.time),
    };
  }

  /** 逐日预报；dayOffset=0 为今天，1 为明天（按目标地点时区）。 */
  async getDailyForecast(location: string, dayOffset: 0 | 1 = 0): Promise<WeatherForecast> {
    const place = await this.geocode(location);
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(place.latitude));
    url.searchParams.set('longitude', String(place.longitude));
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('forecast_days', '2');
    url.searchParams.set('timezone', 'auto');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`天气服务暂时不可用（HTTP ${response.status}）`);
    const payload = await response.json() as { daily?: Record<string, Array<number | string | null>> };
    const daily = payload.daily;
    if (!daily?.time?.[dayOffset]) throw new Error('天气服务未返回逐日预报');
    const probability = daily.precipitation_probability_max?.[dayOffset];
    return {
      location: place.name,
      date: String(daily.time[dayOffset]),
      weatherCode: Number(daily.weather_code?.[dayOffset]),
      maxC: Number(daily.temperature_2m_max?.[dayOffset]),
      minC: Number(daily.temperature_2m_min?.[dayOffset]),
      precipitationProbability: probability === null || probability === undefined ? undefined : Number(probability),
    };
  }

  /** 指定日期（YYYY-MM-DD，目标地点当地日期）的逐日预报，最多支持未来 16 天。 */
  async getForecastForDate(location: string, date: string): Promise<WeatherForecast> {
    const place = await this.geocode(location);
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(place.latitude));
    url.searchParams.set('longitude', String(place.longitude));
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('start_date', date);
    url.searchParams.set('end_date', date);
    url.searchParams.set('timezone', 'auto');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`天气服务暂时不可用（HTTP ${response.status}）`);
    const payload = await response.json() as { daily?: Record<string, Array<number | string | null>> };
    const daily = payload.daily;
    if (!daily?.time?.[0]) throw new Error('天气服务未返回逐日预报');
    const probability = daily.precipitation_probability_max?.[0];
    return {
      location: place.name,
      date: String(daily.time[0]),
      weatherCode: Number(daily.weather_code?.[0]),
      maxC: Number(daily.temperature_2m_max?.[0]),
      minC: Number(daily.temperature_2m_min?.[0]),
      precipitationProbability: probability === null || probability === undefined ? undefined : Number(probability),
    };
  }

  private async geocode(location: string): Promise<GeocodeResult> {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', location.trim());
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'zh');
    url.searchParams.set('format', 'json');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`位置查询失败（HTTP ${response.status}）`);
    const payload = await response.json() as { results?: GeocodeResult[] };
    const place = payload.results?.[0];
    if (!place) throw new Error(`找不到位置“${location}”`);
    return place;
  }
}

export function createWeatherGreeting(snapshot: WeatherSnapshot): WeatherGreeting {
  const code = snapshot.weatherCode;
  const rain = (snapshot.precipitationMm ?? 0) > 0 || [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code);
  const cold = snapshot.temperatureC < 10;
  const hot = snapshot.temperatureC >= 30;
  const title = rain ? '出门记得带伞 ☔' : hot ? '今天注意防暑 ☀️' : cold ? '今天注意保暖 🧥' : '祝你今天旅途愉快 🌤️';
  const details = `${snapshot.location} 当前 ${snapshot.temperatureC}°C${snapshot.humidity !== undefined ? `，湿度 ${snapshot.humidity}%` : ''}`;
  const advice = rain ? '有降水可能，建议带伞并预留路上时间。' : hot ? '天气偏热，建议避开正午暴晒并及时补水。' : cold ? '气温较低，外出建议增加衣物。' : '天气适宜，适合安排户外活动。';
  return { title, message: `${title}\n${details}。${advice}`, snapshot };
}

const WEATHER_TEXT: Array<[number[], string]> = [
  [[0], '晴'], [[1, 2], '多云'], [[3], '阴'], [[45, 48], '有雾'],
  [[51, 53, 55, 56, 57], '毛毛雨'], [[61, 63, 66, 80, 81], '有雨'], [[65, 67, 82], '大雨'],
  [[71, 73, 75, 77, 85, 86], '有雪'], [[95, 96, 99], '雷阵雨'],
];

export function describeWeatherCode(code: number): string {
  return WEATHER_TEXT.find(([codes]) => codes.includes(code))?.[1] ?? '天气多变';
}

/** 把逐日预报整理成适合群发的一段文字。 */
export function formatForecast(forecast: WeatherForecast, dayLabel: string): string {
  const condition = describeWeatherCode(forecast.weatherCode);
  const probability = forecast.precipitationProbability;
  const rainy = (probability ?? 0) >= 50 || /雨|雪/.test(condition);
  const hot = forecast.maxC >= 30;
  const cold = forecast.minC < 10;
  const advice = rainy ? '出门记得带伞，预留路上时间。' : hot ? '天气偏热，注意防晒补水。' : cold ? '早晚偏凉，注意添衣保暖。' : '天气适宜，适合出游。';
  const rain = probability === undefined ? '' : `，降水概率 ${Math.round(probability)}%`;
  return `【${forecast.location}${dayLabel}天气】${condition}，${Math.round(forecast.minC)}~${Math.round(forecast.maxC)}°C${rain}。${advice}`;
}

const TOUR_WEATHER_TEXT: Array<[number[], string]> = [
  [[0], '晴'], [[1], '晴间多云'], [[2], '多云'], [[3], '阴'], [[45, 48], '雾'],
  [[51, 53, 55, 56, 57, 61, 80], '小雨'], [[63, 81], '中雨'], [[65, 82], '大雨'], [[66, 67], '冻雨'],
  [[71, 73, 75, 77, 85, 86], '雪'], [[95, 96, 99], '雷阵雨'],
];

/** 团的明日提醒用的天气描述：晴、多云、阴、小雨……降水概率高但天气代码不是雨时补一句“转阵雨”。 */
export function tourWeatherText(code: number, precipitationProbability?: number): string {
  const text = TOUR_WEATHER_TEXT.find(([codes]) => codes.includes(code))?.[1] ?? '多云';
  return (precipitationProbability ?? 0) >= 60 && !/雨|雪/.test(text) ? `${text}转阵雨` : text;
}

import type { WeatherGreeting, WeatherSnapshot } from '../../src/domain/business';

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

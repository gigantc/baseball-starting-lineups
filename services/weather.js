import fetch from 'node-fetch';
import { DateTime } from 'luxon';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// MLB API misreports some retractable roofs as "Open"
const RETRACTABLE_OVERRIDES = new Set([
  13,   // Globe Life Field (Texas Rangers)
  2395, // T-Mobile Park (Seattle Mariners)
]);

const WMO_DESCRIPTIONS = new Map([
  [0, 'Clear'],
  [1, 'Mostly Clear'],
  [2, 'Partly Cloudy'],
  [3, 'Overcast'],
  [45, 'Fog'],
  [48, 'Fog'],
  [51, 'Light Drizzle'],
  [53, 'Drizzle'],
  [55, 'Heavy Drizzle'],
  [56, 'Freezing Drizzle'],
  [57, 'Freezing Drizzle'],
  [61, 'Light Rain'],
  [63, 'Rain'],
  [65, 'Heavy Rain'],
  [66, 'Freezing Rain'],
  [67, 'Freezing Rain'],
  [71, 'Light Snow'],
  [73, 'Snow'],
  [75, 'Heavy Snow'],
  [77, 'Snow Grains'],
  [80, 'Light Showers'],
  [81, 'Showers'],
  [82, 'Heavy Showers'],
  [85, 'Light Snow Showers'],
  [86, 'Snow Showers'],
  [95, 'Thunderstorm'],
  [96, 'Thunderstorm w/ Hail'],
  [99, 'Thunderstorm w/ Hail'],
]);

export const resolveRoofType = (venueId, apiRoofType) => {
  if (RETRACTABLE_OVERRIDES.has(venueId)) return 'Retractable';
  return apiRoofType || 'Open';
};

export const fetchVenueDetails = async (venueId) => {
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/venues/${venueId}?hydrate=fieldInfo`);
    const data = await res.json();
    const venue = data.venues?.[0];
    return {
      roofType: resolveRoofType(venueId, venue?.fieldInfo?.roofType),
    };
  } catch (error) {
    console.error(`Failed to fetch venue ${venueId}:`, error.message);
    return { roofType: 'Open' };
  }
};

const fetchForecast = async (latitude, longitude) => {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '2',
  });

  const res = await fetch(`${OPEN_METEO_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed (${res.status})`);
  }
  return res.json();
};

// Wind direction from Open-Meteo is "where the wind comes FROM" in degrees.
// Azimuth is the compass bearing from home plate to center field.
//
// To get the wind's effect on the field, we compute the angle between
// the wind's travel direction (windDir + 180) and the field orientation,
// then map that to a baseball-relative description.
const describeWindForBallpark = (windDir, azimuth) => {
  // Wind blows TO this direction
  const windTo = (windDir + 180) % 360;

  // Angle relative to the field: 0 = straight out to center, 180 = straight in from center
  let relative = windTo - azimuth;
  if (relative < 0) relative += 360;
  if (relative > 180) relative -= 360;

  const abs = Math.abs(relative);

  if (abs <= 22.5) return 'out to center';
  if (abs <= 67.5) return relative > 0 ? 'out to right' : 'out to left';
  if (abs <= 112.5) return relative > 0 ? 'cross right to left' : 'cross left to right';
  if (abs <= 157.5) return relative > 0 ? 'in from left' : 'in from right';
  return 'in from center';
};

const formatWeatherString = (tempF, weatherCode, windSpeed, windDir, azimuth) => {
  const condition = WMO_DESCRIPTIONS.get(weatherCode) || 'Unknown';
  const temp = Math.round(tempF);
  const wind = Math.round(windSpeed);

  let windStr;
  if (azimuth != null) {
    const ballparkDir = describeWindForBallpark(windDir, azimuth);
    windStr = `Wind ${wind}mph ${ballparkDir}`;
  } else {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    windStr = `Wind ${wind}mph ${directions[Math.round(windDir / 22.5) % 16]}`;
  }

  return `${temp}°F, ${condition}, ${windStr}`;
};

export const enrichGamesWithWeather = async (siteGames, rawGames) => {
  for (const siteGame of siteGames) {
    const rawGame = rawGames.find((g) => g.gamePk === siteGame.gamePk);
    if (!rawGame) continue;

    const roofType = siteGame.roofType || 'Open';

    if (roofType === 'Dome') {
      siteGame.weather = 'Dome Stadium';
      continue;
    }

    const lat = rawGame.venue?.location?.defaultCoordinates?.latitude;
    const lon = rawGame.venue?.location?.defaultCoordinates?.longitude;
    const azimuth = rawGame.venue?.location?.azimuthAngle;

    if (!lat || !lon) continue;

    try {
      const forecast = await fetchForecast(lat, lon);
      const times = forecast?.hourly?.time || [];
      const temps = forecast?.hourly?.temperature_2m || [];
      const codes = forecast?.hourly?.weather_code || [];
      const winds = forecast?.hourly?.wind_speed_10m || [];
      const windDirs = forecast?.hourly?.wind_direction_10m || [];

      const gameHour = DateTime.fromISO(siteGame.gameDate)
        .setZone(forecast.timezone || 'UTC')
        .startOf('hour')
        .toFormat("yyyy-MM-dd'T'HH:mm");

      const idx = times.indexOf(gameHour);
      if (idx === -1) continue;

      const weatherStr = formatWeatherString(temps[idx], codes[idx], winds[idx], windDirs[idx], azimuth);

      if (roofType === 'Retractable') {
        siteGame.weather = `${weatherStr} (Retractable Roof)`;
      } else {
        siteGame.weather = weatherStr;
      }
    } catch (error) {
      console.error(`Weather fetch failed for ${siteGame.away.abbr} @ ${siteGame.home.abbr}:`, error.message);
    }
  }
};

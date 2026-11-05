export const SETTING_DEFAULTS = {
  daily_cost_cap_usd: 25,
  guest_ai_requests_per_day: 40,
  user_ai_requests_per_day: 150,
  guest_places_requests_per_day: 120,
  user_places_requests_per_day: 500,
};
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = Record<SettingKey, number>;

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM app_settings').all<{ key: string; value: string }>();
  const settings: Settings = { ...SETTING_DEFAULTS };
  for (const row of results) {
    const n = Number(row.value);
    if (row.key in settings && Number.isFinite(n)) settings[row.key as SettingKey] = n;
  }
  return settings;
}

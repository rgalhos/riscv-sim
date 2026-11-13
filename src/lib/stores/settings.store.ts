import { persistentJSON } from "@nanostores/persistent";

const SIMULATOR_SETTINGS_STORAGE_KEY = "simulator_settings";

export const DEFAULT_STEP_SPEED = 1000;
export const MAX_STEP_SPEED = 10_000_000;

const defaultSettings = {
  stepSpeed: DEFAULT_STEP_SPEED,
  focusOnStep: false,
};

export const $settings = persistentJSON(SIMULATOR_SETTINGS_STORAGE_KEY, defaultSettings);

export function sanitizeStepSpeed(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_STEP_SPEED;
  return Math.min(n, MAX_STEP_SPEED);
}

export const getStepSpeed = () => sanitizeStepSpeed($settings.get().stepSpeed);

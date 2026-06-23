import { useSyncExternalStore } from "react";
import { getSettings, resetSettings, subscribeSettings, updateSettings } from "../lib/settingsStore";

export function useSettings() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings);
  return { settings, updateSettings, resetSettings };
}

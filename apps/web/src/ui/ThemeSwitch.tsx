import { useTheme, type ThemePref } from '../theme.js';
import { Segmented, type SegmentedOption } from './Segmented.js';

const OPTIONS: readonly SegmentedOption<ThemePref>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

export function ThemeSwitch() {
  const [pref, setPref] = useTheme();
  return <Segmented label="Colour mode" options={OPTIONS} value={pref} onChange={setPref} />;
}

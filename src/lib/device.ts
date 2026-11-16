/** A short, human-readable machine label from the platform information Chrome exposes.
 *  Web pages cannot read the operating-system hostname, so this is the closest available name. */
export function machineLabel(platform?: string): string {
  const raw = (platform ?? (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '').trim();
  if (/mac/i.test(raw)) return 'macOS';
  if (/win/i.test(raw)) return 'Windows';
  if (/cros|chrome\s*os/i.test(raw)) return 'ChromeOS';
  if (/android/i.test(raw)) return 'Android';
  if (/iphone|ipad|ipod/i.test(raw)) return 'iOS';
  if (/linux/i.test(raw)) return 'Linux';
  return raw || 'этом компьютере';
}

if (typeof window !== 'undefined') (window as Window & { __carverMachineLabel?: typeof machineLabel }).__carverMachineLabel = machineLabel;

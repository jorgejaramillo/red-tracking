import type { EnvironmentCheck } from '@red-tracking/protocol';

export interface EnvInput {
  faceDetected: boolean;
  faceScale: number;
  brightness: number;
  earJitter: number;
}

/** Hints are i18n keys resolved by the UI. */
export function assessEnvironment(i: EnvInput): EnvironmentCheck {
  const hints: string[] = [];
  if (!i.faceDetected) hints.push('env_no_face');
  else {
    if (i.faceScale < 0.18) hints.push('env_too_far');
    if (i.faceScale > 0.55) hints.push('env_too_close');
    if (i.earJitter > 0.08) hints.push('env_unstable');
  }
  if (i.brightness < 60) hints.push('env_too_dark');
  if (i.brightness > 215) hints.push('env_too_bright');
  return { ...i, ok: hints.length === 0, hints };
}

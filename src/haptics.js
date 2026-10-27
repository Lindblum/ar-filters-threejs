// The XR controllers' buzz, at Accessibility → Vibration's strength.

let strength = 1; // 0 (off) to 2; 1 as made

/** Accessibility → Vibration: every pulse's strength, a multiplier. */
export function setVibration(v) {
  strength = v;
}

/** A pulse on `gamepad`'s controller (nothing without one, or at Off); `intensity` 0..1 as made, for `ms`. */
export function pulse(gamepad, intensity, ms) {
  const v = Math.min(1, intensity * strength); // (1: the most a controller does)
  if (!gamepad || v <= 0) return;
  try {
    const actuator = gamepad.hapticActuators?.[0];
    if (actuator?.pulse) actuator.pulse(v, ms);
    else gamepad.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: v });
  } catch {
    /* no haptics here */
  }
}

/** A pulse on every controller in XR session `session`. */
export function pulseAll(session, intensity, ms) {
  for (const source of session?.inputSources ?? []) pulse(source.gamepad, intensity, ms);
}

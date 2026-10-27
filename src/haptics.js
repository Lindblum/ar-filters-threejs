// The XR controllers' buzz: as a press, grab or dock happens.

/** A pulse on `gamepad`'s controller (nothing without one); `intensity` 0..1, for `ms`. */
export function pulse(gamepad, intensity, ms) {
  if (!gamepad) return;
  try {
    const actuator = gamepad.hapticActuators?.[0];
    if (actuator?.pulse) actuator.pulse(intensity, ms);
    else gamepad.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: intensity });
  } catch {
    /* no haptics here */
  }
}

// Bridges the P5 legacy views (which take a `tick` refresh prop) into the new shell until their replacements land.
import { useState } from 'react';
import { useLive } from './live.jsx';

export function useTick(on = '*') {
  const [tick, setTick] = useState(0);
  useLive(on, () => setTick((t) => t + 1));
  return tick;
}

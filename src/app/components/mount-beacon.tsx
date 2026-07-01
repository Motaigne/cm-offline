'use client';

import { useEffect } from 'react';

/** Signale au watchdog inline (cf. layout.tsx) que React a bien monté.
 *  Sans ce signal après ~10s, le watchdog affiche un filet de secours
 *  « Réparer et recharger » — utile quand un chunk JS n'a pas pu charger
 *  (wifi captif / cache incohérent) et que l'app reste sur un écran blanc. */
export function MountBeacon() {
  useEffect(() => {
    const w = window as unknown as { __cmMounted?: boolean };
    w.__cmMounted = true;
    window.dispatchEvent(new Event('cm-mounted'));
  }, []);
  return null;
}

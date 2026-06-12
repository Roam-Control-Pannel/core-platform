import { useEffect, useState } from "react";
import * as Location from "expo-location";

// The named fallback origin. When the device location is denied or unavailable we re-root
// Discover here so the list still loads — Darlington is Roam's proof locality.
export const DARLINGTON = { lat: 54.5253, lng: -1.5849 } as const;

export type Origin = { lat: number; lng: number };

// Discriminated union of the resolution states. The screen renders each one honestly:
//  - resolving: asking for permission / waiting on the first fix (show a spinner)
//  - ready:     a real device fix; origin is the device's coords ("near you")
//  - fallback:  denied or unavailable; origin is Darlington ("near Darlington")
export type DeviceOrigin =
  | { status: "resolving"; origin: null }
  | { status: "ready"; origin: Origin }
  | { status: "fallback"; origin: Origin };

// Resolve a device origin exactly once on mount. We deliberately do NOT subscribe to
// location updates: Discover wants a single origin to root the near->far query, not a live
// stream. A re-root on movement is a later, explicit slice if we ever want it.
export function useDeviceOrigin(): DeviceOrigin {
  const [state, setState] = useState<DeviceOrigin>({
    status: "resolving",
    origin: null,
  });

  useEffect(() => {
    // Guard against a setState after unmount (the permission prompt can outlive a fast
    // screen dismissal).
    let active = true;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!active) return;

        if (status !== "granted") {
          // User declined (or it's restricted) — fall back, don't block discovery.
          setState({ status: "fallback", origin: DARLINGTON });
          return;
        }

        const fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!active) return;

        setState({
          status: "ready",
          origin: { lat: fix.coords.latitude, lng: fix.coords.longitude },
        });
      } catch {
        // Location services off, no fix obtainable, or the module threw — fall back so the
        // screen is never stuck resolving.
        if (active) setState({ status: "fallback", origin: DARLINGTON });
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  return state;
}

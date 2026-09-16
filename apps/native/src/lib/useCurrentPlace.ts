/**
 * useCurrentPlace — the native analogue of web's useCurrentPlace / PlaceSwitcher `Place`.
 *
 * Home's local sections all answer "what's happening HERE", and they need the place in two
 * shapes: a CENTRE (lat/lng — posts.feed and venues.near are geofenced reads) and a NAME
 * (townHall.listTopics keys its board off the locality name). So a Place carries both, and
 * every section roots off the same one — Home never shows a feed for one town beside a
 * forum for another.
 *
 * Resolution, in order:
 *   1. The device fix from useDeviceOrigin (permission-gated, resolved once).
 *   2. Reverse-geocode that fix to a locality name, so the board matches where you are.
 *   3. DEFAULT_PLACE (Darlington, Roam's proof locality) when location is denied,
 *      unavailable, or the reverse lookup yields no name — the page always has a place.
 *
 * The selection is read-only here. Web layers a switcher (search · saved · suggested) on
 * top of the same Place shape; that's a later native slice, and it plugs in without the
 * sections changing, because they only ever see a resolved Place.
 */
import { useEffect, useState } from "react";
import * as Location from "expo-location";
import { useDeviceOrigin } from "./useDeviceOrigin";

/** Mirrors web's PlaceSwitcher `Place` (the fields the reads actually consume). */
export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * Suggested centres covering the seeded venues — the same pair web's PlaceSwitcher offers.
 * Kept here so a native switcher has somewhere to read them from.
 */
export const PLACES: readonly Place[] = [
  { id: "darlington", name: "Darlington", lat: 54.5253, lng: -1.5536 },
  { id: "stockton", name: "Stockton-on-Tees", lat: 54.5705, lng: -1.311 },
] as const;

/** The default place when none is resolved — Darlington, the seed's centre of gravity. */
export const DEFAULT_PLACE: Place = PLACES[0]!;

export interface CurrentPlace {
  place: Place;
  /**
   * How we arrived at this place. `resolving` still carries DEFAULT_PLACE so the sections
   * can render immediately; `detected` means the name came from the device's own fix.
   */
  status: "resolving" | "detected" | "fallback";
}

export function useCurrentPlace(): CurrentPlace {
  const origin = useDeviceOrigin();
  const [resolved, setResolved] = useState<Place | null>(null);

  useEffect(() => {
    // Only a REAL fix earns a reverse lookup. The fallback origin is already a named place,
    // so geocoding it would just spend a request to rediscover "Darlington".
    if (origin.status !== "ready") return;
    const { lat, lng } = origin.origin;
    let active = true;

    (async () => {
      try {
        const [first] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
        if (!active) return;
        // Prefer the town/settlement over the sub-locality: the forum is keyed per town.
        const name = first?.city ?? first?.subregion ?? first?.district ?? null;
        setResolved({
          id: name ? `detected:${name.toLowerCase()}` : "detected",
          name: name ?? DEFAULT_PLACE.name,
          lat,
          lng,
        });
      } catch {
        // Reverse geocoding unavailable (no network, no provider) — keep the real centre so
        // the geofenced reads still root correctly, and borrow the default's name for the board.
        if (active) setResolved({ id: "detected", name: DEFAULT_PLACE.name, lat, lng });
      }
    })();

    return () => {
      active = false;
    };
  }, [origin.status, origin.origin]);

  if (resolved) return { place: resolved, status: "detected" };
  if (origin.status === "resolving") return { place: DEFAULT_PLACE, status: "resolving" };
  return { place: DEFAULT_PLACE, status: "fallback" };
}

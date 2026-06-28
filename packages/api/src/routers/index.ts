/**
 * The app router — the single tRPC surface every shell calls.
 *
 * Each domain is a sub-router. Adding procedures inside a sub-router is additive and
 * never breaks a consumer; this barrel is the stable contract.
 */
import { router } from "../trpc.js";
import { creditsRouter } from "./credits.js";
import { postsRouter } from "./posts.js";
import { venuesRouter } from "./venues.js";
import { socialRouter } from "./social.js";
import { meetupRouter } from "./meetup.js";
import { chatRouter } from "./chat.js";
import { placesRouter } from "./places.js";
import { geoRouter } from "./geo.js";
import { profilesRouter } from "./profiles.js";
import { moderationRouter } from "./moderation.js";
import { townHallRouter } from "./townHall.js";

export const appRouter = router({
  credits: creditsRouter,
  posts: postsRouter,
  venues: venuesRouter,
  social: socialRouter,
  meetup: meetupRouter,
  chat: chatRouter,
  places: placesRouter,
  geo: geoRouter,
  profiles: profilesRouter,
  moderation: moderationRouter,
  townHall: townHallRouter,
});

/** The contract every shell imports for end-to-end types. */
export type AppRouter = typeof appRouter;

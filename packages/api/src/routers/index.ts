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
import { offersRouter } from "./offers.js";
import { profileWallRouter } from "./profileWall.js";
import { notificationsRouter } from "./notifications.js";
import { plansRouter } from "./plans.js";
import { seoRouter } from "./seo.js";
import { marketingRouter } from "./marketing.js";
import { transitRouter } from "./transit.js";
import { venueActivityRouter } from "./venueActivity.js";
import { venueMarketingRouter } from "./venueMarketing.js";
import { suggestionsRouter } from "./suggestions.js";
import { venueAudienceRouter } from "./venueAudience.js";
import { venueBirthdayRouter } from "./venueBirthday.js";
import { birthdayRouter } from "./birthday.js";
import { pollRouter } from "./poll.js";
import { dealsRouter } from "./deals.js";

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
  offers: offersRouter,
  profileWall: profileWallRouter,
  notifications: notificationsRouter,
  plans: plansRouter,
  seo: seoRouter,
  marketing: marketingRouter,
  transit: transitRouter,
  venueActivity: venueActivityRouter,
  venueMarketing: venueMarketingRouter,
  suggestions: suggestionsRouter,
  venueAudience: venueAudienceRouter,
  venueBirthday: venueBirthdayRouter,
  birthday: birthdayRouter,
  poll: pollRouter,
  deals: dealsRouter,
});

/** The contract every shell imports for end-to-end types. */
export type AppRouter = typeof appRouter;

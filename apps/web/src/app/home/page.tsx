/**
 * /home now redirects to the landing page (/), which is the Home hub. Kept so any existing
 * /home links and bookmarks resolve rather than 404.
 */
import { redirect } from "next/navigation";

export default function HomeRedirect() {
  redirect("/");
}

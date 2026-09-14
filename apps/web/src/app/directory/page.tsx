/**
 * /directory — the F2G members directory (C2-b), the channel's flagship at-scale surface.
 *
 * Server-rendered and INDEXABLE on a branded channel (unlike the noindex jobs/suppliers boards): the
 * members roster is the channel's OWN content, so under the Consolidated SEO model (A3-b) this page
 * canonicals to the channel's own origin and carries an ItemList of members. The first page is fetched
 * here for crawlers + first paint; the <Directory> client component then owns search/filter/near-me.
 *
 * Channel-scoped: only a channel that exposes `sections.directory` renders the list (the launch flip,
 * like jobs/suppliers). The default Roam channel has no members and is always noindex. force-dynamic
 * because the channel resolves per-request from the x-roam-channel header.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Directory } from "../../components/Directory";
import { JsonLd } from "../../components/JsonLd";
import { getChannelInfo, getDirectory } from "../../lib/serverApi";
import { directoryMetadata, directoryJsonLd, directoryIndexable } from "../../lib/seo";
import { isSectionEnabled } from "../../lib/channel";

export async function generateMetadata(): Promise<Metadata> {
  const channel = await getChannelInfo();
  if (!channel || !isSectionEnabled(channel.sections, "directory")) {
    return { title: "Members", robots: { index: false, follow: true } };
  }
  const page = await getDirectory(channel.key);
  return directoryMetadata(channel.key, channel.name, channel.isDefault, page.entries.length);
}

export default async function DirectoryPage() {
  const channel = await getChannelInfo();
  const exposed = !!channel && isSectionEnabled(channel.sections, "directory");
  const page = exposed ? await getDirectory(channel!.key) : { entries: [], hasMore: false, nextOffset: 0 };

  return (
    <>
      {exposed && directoryIndexable(channel!.isDefault, page.entries.length) ? (
        <JsonLd data={directoryJsonLd(channel!.key, channel!.name, page.entries)} />
      ) : null}
      <Directory initialEntries={page.entries} initialHasMore={page.hasMore} />
    </>
  );
}

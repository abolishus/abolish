import { createFileRoute, notFound } from "@tanstack/react-router";

import { ProfilePage } from "../components/profile-page.tsx";
import { fetchProfile } from "../data.ts";
import { reportProfile } from "../profile-report.ts";
import { isElectionId, PROFILE_HANDLE, searchText } from "../values.ts";

// A creator's profile, `/by/<handle>` ([[0040-creator-profiles]]): its name
// and the polls it shows, a page at a time. Read by our own server from the
// account side, never the API (T-10); never indexed, so unlinking a poll or
// deleting the profile takes effect wherever we can make it; counted as
// `/by/:handle`, never the handle (src/analytics.ts; T-67).
export const Route = createFileRoute("/by/$handle")({
  // Anything but a canonical election ID as `after` starts from the top.
  validateSearch: (search: Record<string, unknown>): { after: string | undefined } => {
    const after = searchText(search["after"]);
    return { after: isElectionId(after) ? after : undefined };
  },
  loaderDeps: ({ search }) => ({ after: search.after ?? "" }),
  loader: async ({ params, deps }) => {
    // One spelling per profile: anything but a canonical handle isn't one.
    if (!PROFILE_HANDLE.test(params.handle)) throw notFound();
    const page = await fetchProfile({ data: { handle: params.handle, after: deps.after } });
    if (page.profile.kind === "not-found") throw notFound();
    return { ...page, profile: page.profile };
  },
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function By() {
    const { handle } = Route.useParams();
    const { after } = Route.useSearch();
    const { profile, ballot } = Route.useLoaderData();
    return (
      <ProfilePage
        handle={handle}
        profile={profile}
        paged={after !== undefined}
        ballot={ballot}
        report={reportProfile}
      />
    );
  },
});

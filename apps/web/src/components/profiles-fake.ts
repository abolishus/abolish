// A profiles handler in memory, for the stories of every component that
// calls one (account-profile, account-polls, poll-form): no network.

import {
  type OwnProfileView,
  type ProfileModerationView,
  ProfilesError,
  type ProfilesClient,
} from "../account/profiles.ts";

export const HANDLE = "k7tq2mxa4vb3pz6r";

const VISIBLE: ProfileModerationView = {
  state: "visible",
  latest: undefined,
  appealable: false,
  appeals: [],
};

/** A profiles handler in memory: the section's calls, with no network. */
export function fakeProfiles({
  profile,
  moderation = VISIBLE,
  refuse,
}: {
  profile?: OwnProfileView;
  moderation?: ProfileModerationView;
  /** Every change ends this way. */
  refuse?: ProfilesError;
} = {}): ProfilesClient & { calls: string[] } {
  let own = profile;
  let m = moderation;
  const calls: string[] = [];
  const act = (call: string) => {
    calls.push(call);
    if (refuse !== undefined) throw refuse;
  };
  return {
    calls,
    own: async () => own,
    make: async (name) => {
      act(`make ${name}`);
      own = { handle: HANDLE, name, renamableOn: "2026-10-23", pollIds: [] };
      return HANDLE;
    },
    rename: async (name) => {
      act(`rename ${name}`);
      if (own === undefined) throw new ProfilesError("changed");
      if (own.name === name) return false;
      own = { ...own, name, renamableOn: "2026-10-23" };
      return true;
    },
    remove: async () => {
      act("remove");
      own = undefined;
    },
    moderation: async () => m,
    show: async (pollId, on) => {
      act(`show ${pollId} ${on}`);
      if (own === undefined) throw new ProfilesError("changed");
      if (own.pollIds.includes(pollId) === on) return false;
      own = {
        ...own,
        pollIds: on ? [...own.pollIds, pollId] : own.pollIds.filter((id) => id !== pollId),
      };
      return true;
    },
    appeal: async () => {
      act("appeal");
      if (m.latest === undefined) throw new ProfilesError("changed");
      m = {
        ...m,
        appealable: false,
        appeals: [
          {
            decisionSeq: m.latest.seq,
            filedAt: "2026-10-21T09:30:00.000Z",
            outcome: undefined,
            reviewedAt: undefined,
          },
        ],
      };
    },
  };
}

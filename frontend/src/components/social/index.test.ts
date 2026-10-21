import { describe, expect, it, vi } from 'vitest';

import * as social from '.';
import * as followButtonEntry from './FollowButton';
import { FollowButton } from './FollowButton/FollowButton';
import * as followListModalEntry from './FollowListModal';
import { FollowListModal } from './FollowListModal/FollowListModal';
import * as followRequestsModalEntry from './FollowRequestsModal';
import { FollowRequestsModal } from './FollowRequestsModal/FollowRequestsModal';
import * as followStatsEntry from './FollowStats';
import { FollowStats } from './FollowStats/FollowStats';
import * as mutualFollowersEntry from './MutualFollowers';
import { MutualFollowers } from './MutualFollowers/MutualFollowers';
import * as userCardEntry from './UserCard';
import { UserCard } from './UserCard/UserCard';

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

describe('social component entry points', () => {
  it('re-exports every social component from the barrel', () => {
    expect({ ...social }).toEqual({
      FollowButton,
      FollowListModal,
      FollowRequestsModal,
      FollowStats,
      MutualFollowers,
      UserCard,
    });
  });

  it.each([
    ['FollowButton', followButtonEntry, FollowButton],
    ['FollowListModal', followListModalEntry, FollowListModal],
    ['FollowRequestsModal', followRequestsModalEntry, FollowRequestsModal],
    ['FollowStats', followStatsEntry, FollowStats],
    ['MutualFollowers', mutualFollowersEntry, MutualFollowers],
    ['UserCard', userCardEntry, UserCard],
  ])('exposes %s as both a named and the default export', (name, entry, component) => {
    expect({ ...entry }).toEqual({ default: component, [name]: component });
  });
});

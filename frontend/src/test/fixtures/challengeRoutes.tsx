/**
 * Routing fixture for the Challenges screens: renders them at their real paths, with a stand-in
 * Home, the location probe of `renderWithHistory` and an optional navigator.
 *
 * Test files using it must mock `services/api` (see `createChallengeApiMock`), since the screens
 * load data through `challengeApi`.
 */
import type { ReactElement } from 'react';
import { type InitialEntry, Route, Routes } from 'react-router-dom';

import { ChallengeDetailPage } from '../../components/challenges/ChallengeDetailPage';
import { ChallengesPage } from '../../components/challenges/ChallengesPage';
import { JoinChallengePage } from '../../components/challenges/JoinChallengePage';
import { renderWithHistory } from './shell';

export function renderChallengeRoutes(entries: InitialEntry[], extra?: ReactElement) {
  return renderWithHistory(
    <>
      <Routes>
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/challenges" element={<ChallengesPage />} />
        <Route path="/challenges/:id" element={<ChallengeDetailPage />} />
        <Route path="/c/:code" element={<JoinChallengePage />} />
      </Routes>
      {extra}
    </>,
    { entries }
  );
}

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import confetti from 'canvas-confetti';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { badge } from '../test/fixtures/social';
import { createMatchMedia } from '../test/utils';
import BadgeUnlockModalDefault, { BadgeUnlockModal } from './BadgeUnlockModal';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof BadgeUnlockModal>;

const WEEK = badge({ key: 'streak_7', name: 'Week Warrior', threshold: 7, icon: 'Flame' });
const STARTER = badge({
  key: 'streak_3',
  name: 'Getting Started',
  threshold: 3,
  icon: 'Footprints',
});
const MONTH = badge({ key: 'streak_30', name: 'Monthly Master', threshold: 30, icon: 'Shield' });

function renderModal(props: Partial<Props> = {}) {
  const onClose = vi.fn();
  const utils = render(<BadgeUnlockModal badges={[WEEK]} isOpen onClose={onClose} {...props} />);
  return { ...utils, onClose };
}

describe('BadgeUnlockModal', () => {
  beforeEach(() => {
    // Overlay history logs every open/close in development builds.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it.each([
    ['closed', { isOpen: false }],
    ['open without badges', { badges: [] }],
  ])('renders nothing when %s', (_label, props) => {
    renderModal(props);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('celebrates a single badge and focuses the dismiss button', () => {
    renderModal();

    const dialog = screen.getByRole('dialog', { name: 'Badge unlocked!' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('New badge')).toBeInTheDocument();
    expect(within(dialog).getByText('Week Warrior')).toBeInTheDocument();
    expect(within(dialog).getByText('You kept a 7-day streak going')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Awesome!' })).toHaveFocus();
  });

  it('lists every unlocked badge, highest streak first', () => {
    renderModal({ badges: [STARTER, MONTH, WEEK] });

    const dialog = screen.getByRole('dialog', { name: 'Badges unlocked!' });
    expect(within(dialog).getByText('3 new badges')).toBeInTheDocument();
    const items = within(dialog).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Monthly Master30-day streak',
      'Week Warrior7-day streak',
      'Getting Started3-day streak',
    ]);
  });

  describe('closing', () => {
    it('closes from the dismiss button', async () => {
      const user = userEvent.setup();
      const { onClose } = renderModal();

      await user.click(screen.getByRole('button', { name: 'Awesome!' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes with the Escape key', async () => {
      const user = userEvent.setup();
      const { onClose } = renderModal();

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the backdrop is clicked but not when the card is clicked', async () => {
      const user = userEvent.setup();
      const { onClose } = renderModal();
      const dialog = screen.getByRole('dialog');

      await user.click(within(dialog).getByText('Week Warrior'));
      expect(onClose).not.toHaveBeenCalled();

      await user.click(dialog.parentElement!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    // Unmount with real timers so overlay history cleanup is not stranded on fake timers.
    afterEach(() => {
      vi.useRealTimers();
    });

    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });

    it('fires brand-colored confetti from both sides shortly after opening', () => {
      renderModal();

      advance(299);
      expect(confetti).not.toHaveBeenCalled();

      advance(1);
      expect(confetti).toHaveBeenCalledTimes(3);
      expect(vi.mocked(confetti).mock.calls.map(([options]) => options?.particleCount)).toEqual([
        24, 32, 24,
      ]);
      expect(confetti).toHaveBeenCalledWith(
        expect.objectContaining({
          colors: ['#22c55e', '#14b8a6', '#6447f2', '#ec4899', '#f59e0b'],
          origin: { x: 0.3, y: 0.7 },
        })
      );
    });

    it('asks canvas-confetti to skip the effect for users who prefer reduced motion', () => {
      vi.stubGlobal(
        'matchMedia',
        createMatchMedia((query) => query.includes('prefers-reduced-motion'))
      );
      renderModal();

      advance(300);

      for (const [options] of vi.mocked(confetti).mock.calls) {
        expect(options).toMatchObject({ disableForReducedMotion: true });
      }
    });

    it('closes itself after five seconds using the latest onClose', () => {
      const { onClose, rerender } = renderModal();
      const latestOnClose = vi.fn();

      advance(4000);
      rerender(<BadgeUnlockModal badges={[WEEK]} isOpen onClose={latestOnClose} />);
      advance(999);
      expect(latestOnClose).not.toHaveBeenCalled();

      advance(1);
      expect(latestOnClose).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('cancels confetti and auto-close when it is closed early', () => {
      const { onClose, rerender } = renderModal();

      advance(100);
      rerender(<BadgeUnlockModal badges={[WEEK]} isOpen={false} onClose={onClose} />);
      advance(10_000);

      expect(confetti).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('is exported as the default export', () => {
    expect(BadgeUnlockModalDefault).toBe(BadgeUnlockModal);
  });
});

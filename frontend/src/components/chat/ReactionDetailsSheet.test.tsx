import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeChatMessage, ME, PEER, reaction } from '../../test/fixtures/chat';
import { ReactionDetailsSheet } from './ReactionDetailsSheet';

const renderSheet = (reactions = [reaction(PEER.id, '😮'), reaction(99, '👍')]) => {
  const onRemoveMine = vi.fn();
  const onClose = vi.fn();
  render(
    <ReactionDetailsSheet
      message={makeChatMessage({ reactions })}
      meId={ME.id}
      meName={ME.username}
      peer={PEER}
      onRemoveMine={onRemoveMine}
      onClose={onClose}
    />
  );
  return { user: userEvent.setup(), onRemoveMine, onClose };
};

describe('ReactionDetailsSheet', () => {
  it('lists who reacted, falling back for people it does not know', () => {
    renderSheet();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('Someone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove your/ })).not.toBeInTheDocument();
  });

  it('says when there are no reactions left', () => {
    renderSheet([]);
    expect(screen.getByText('No reactions yet.')).toBeInTheDocument();
  });

  it('removes my reaction', async () => {
    const { user, onRemoveMine } = renderSheet([reaction(ME.id, '🙏')]);
    expect(screen.getByText('Tap to remove')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove your 🙏 reaction' }));
    expect(onRemoveMine).toHaveBeenCalledTimes(1);
  });
});

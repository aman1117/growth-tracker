/**
 * ReactionDetailsSheet
 *
 * Who reacted to a message, and with what. My own reaction can be removed from here.
 */

import { SmilePlus } from 'lucide-react';
import React from 'react';

import type { ChatThreadMessage, ChatUser } from '../../types/chat';
import { Avatar, Modal } from '../ui';
import styles from './ReactionDetailsSheet.module.css';

export interface ReactionDetailsSheetProps {
  message: ChatThreadMessage;
  meId: number;
  meName: string;
  meAvatar?: string | null;
  peer: ChatUser;
  onRemoveMine: () => void;
  onClose: () => void;
}

export const ReactionDetailsSheet: React.FC<ReactionDetailsSheetProps> = ({
  message,
  meId,
  meName,
  meAvatar,
  peer,
  onRemoveMine,
  onClose,
}) => (
  <Modal isOpen onClose={onClose} title="Reactions" icon={<SmilePlus size={20} />} size="small">
    {message.reactions.length === 0 ? (
      <p className={styles.empty}>No reactions yet.</p>
    ) : (
      <ul className={styles.list}>
        {message.reactions.map((reaction) => {
          const mine = reaction.user_id === meId;
          const name = mine ? meName : reaction.user_id === peer.id ? peer.username : 'Someone';
          const avatar = mine ? meAvatar : reaction.user_id === peer.id ? peer.profile_pic : null;
          const content = (
            <>
              <Avatar src={avatar} name={name} size="sm" />
              <span className={styles.who}>
                <span className={styles.name}>{mine ? 'You' : name}</span>
                {mine && <span className={styles.hint}>Tap to remove</span>}
              </span>
              <span className={styles.emoji}>{reaction.emoji}</span>
            </>
          );
          return (
            <li key={reaction.user_id}>
              {mine ? (
                <button
                  type="button"
                  className={`${styles.row} ${styles.removable}`}
                  onClick={onRemoveMine}
                  aria-label={`Remove your ${reaction.emoji} reaction`}
                >
                  {content}
                </button>
              ) : (
                <div className={styles.row}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    )}
  </Modal>
);

export default ReactionDetailsSheet;

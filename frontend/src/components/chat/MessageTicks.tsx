/**
 * MessageTicks
 *
 * Delivery state of one of my messages, like WhatsApp: a clock while sending, one tick when
 * the server has it, two muted ticks once delivered, two accent ticks once read, and a red
 * alert when sending failed.
 */

import { Check, CheckCheck, CircleAlert, Clock } from 'lucide-react';
import React from 'react';

import type { ChatTickStatus } from '../../types/chat';
import styles from './MessageTicks.module.css';

const LABELS: Record<ChatTickStatus, string> = {
  pending: 'Sending',
  failed: 'Not sent',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

export interface MessageTicksProps {
  status: ChatTickStatus;
  size?: number;
  className?: string;
}

export const MessageTicks: React.FC<MessageTicksProps> = ({ status, size = 14, className }) => {
  const icon = (() => {
    switch (status) {
      case 'pending':
        return <Clock size={size - 2} strokeWidth={2.4} />;
      case 'failed':
        return <CircleAlert size={size} strokeWidth={2.4} />;
      case 'sent':
        return <Check size={size} strokeWidth={2.6} />;
      default:
        return <CheckCheck size={size} strokeWidth={2.6} />;
    }
  })();

  return (
    <span
      className={`${styles.ticks} ${styles[status]} ${className ?? ''}`}
      role="img"
      aria-label={LABELS[status]}
      data-status={status}
    >
      {icon}
    </span>
  );
};

export default MessageTicks;

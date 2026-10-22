/**
 * AvatarStack Component
 *
 * Overlapping avatars for a group of people ("alice, bob and 3 others"), with a
 * "+N" bubble when there are more people than avatars shown. The stack is one
 * image for assistive technology, described by `label`.
 */

import React from 'react';

import { Avatar } from '../Avatar';
import styles from './AvatarStack.module.css';

export interface AvatarStackPerson {
  /** Stable key, e.g. the user id */
  id: React.Key;
  /** Username: image alt text and initials fallback */
  name: string;
  src?: string | null;
  thumbnailSrc?: string | null;
}

export type AvatarStackSize = 'xs' | 'sm' | 'md';

export interface AvatarStackProps {
  people: AvatarStackPerson[];
  /** Most avatars shown before the "+N" bubble */
  max?: number;
  /** Size of the whole group when `people` is only a preview of it */
  total?: number;
  size?: AvatarStackSize;
  /** Accessible description; defaults to the names shown and how many others there are */
  label?: string;
  className?: string;
}

const joinNames = (names: string[]): string => {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

const describeGroup = (names: string[], others: number): string => {
  if (others <= 0) return joinNames(names);
  const othersText = `${others} ${others === 1 ? 'other' : 'others'}`;
  if (names.length === 0) return `${others} ${others === 1 ? 'person' : 'people'}`;
  return `${names.join(', ')} and ${othersText}`;
};

export const AvatarStack: React.FC<AvatarStackProps> = ({
  people,
  max = 4,
  total,
  size = 'sm',
  label,
  className = '',
}) => {
  const shown = people.slice(0, Math.max(0, Math.floor(max)));
  const groupSize = Math.max(total ?? people.length, people.length);
  const overflow = groupSize - shown.length;

  if (groupSize === 0) return null;

  const description =
    label ??
    describeGroup(
      shown.map((person) => person.name),
      overflow
    );

  return (
    <div
      className={`${styles.stack} ${styles[size]} ${className}`.trim()}
      role="img"
      aria-label={description}
    >
      {shown.map((person, index) => (
        <span key={person.id} className={styles.item} style={{ zIndex: shown.length - index }}>
          <Avatar
            src={person.src}
            thumbnailSrc={person.thumbnailSrc}
            name={person.name}
            size={size}
          />
        </span>
      ))}
      {overflow > 0 && (
        <span className={`${styles.item} ${styles.more}`} aria-hidden="true">
          +{overflow}
        </span>
      )}
    </div>
  );
};

export default AvatarStack;

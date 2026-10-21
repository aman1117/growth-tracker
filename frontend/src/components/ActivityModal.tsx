/**
 * ActivityModal Component
 *
 * Logs (or edits) the hours and an optional note for one activity on the
 * selected day. Built on the shared Modal and kept as a top-anchored dialog on
 * phones so the on-screen keyboard never hides the actions.
 */

import type { LucideIcon } from 'lucide-react';
import { AlertCircle, AlertTriangle, ChevronDown } from 'lucide-react';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { getActivityConfig } from '../constants/activities';
import type { ActivityName, CustomTile } from '../types';
import { applyCharacterLimit, characterCount } from '../utils/text';
import styles from './ActivityModal.module.css';
import { DynamicIcon } from './DynamicIcon';
import { Button, Modal } from './ui';

interface ActivityModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (hours: number, note?: string) => Promise<void>;
  activityName: ActivityName | null;
  currentHours: number;
  currentNote?: string;
  customTiles?: CustomTile[]; // Pass custom tiles for name lookup
  /** User color overrides so the header matches the tile */
  colorOverrides?: Record<string, string>;
  /** Day being logged, shown under the title */
  date?: Date;
  /** Hours already logged across all activities that day (including this one) */
  dayTotalHours?: number;
}

const MAX_HOURS = 24;
const STEP_HOURS = 0.25;
const NOTE_LIMIT = 500;
const LONG_NOTE_CHARS = 50;
const DECREMENTS = [-0.5, -0.25] as const;
const INCREMENTS = [0.25, 0.5] as const;
const QUARTER_HOUR_HINT = 'Use quarter hours, e.g. 0.25, 1.5 or 8';

/** Rounds to the nearest quarter hour and clamps to a single day */
const snapToStep = (value: number): number =>
  Math.min(MAX_HOURS, Math.max(0, Math.round(value / STEP_HOURS) * STEP_HOURS));

/** Accepts "1.5" and "1,5"; returns null for empty or non-numeric input */
const parseHours = (raw: string): number | null => {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

const isQuarterHour = (value: number): boolean =>
  Math.abs(value / STEP_HOURS - Math.round(value / STEP_HOURS)) < 1e-9;

/** "2h 30m", "2h", "45m" */
const describeHours = (hours: number): string => {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

const formatDayLabel = (date: Date): string => {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(date);
};

export const ActivityModal: React.FC<ActivityModalProps> = ({
  isOpen,
  onClose,
  onSave,
  activityName,
  currentHours,
  currentNote,
  customTiles = [],
  colorOverrides,
  date,
  dayTotalHours,
}) => {
  const [hours, setHours] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [isNoteExpanded, setIsNoteExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const hoursInputRef = useRef<HTMLInputElement>(null);

  const formId = useId();
  const hoursId = useId();
  const hoursHintId = useId();
  const noteId = useId();
  const errorId = useId();

  // Prefill synchronously when the dialog opens (not in an effect), so the very
  // first frame shows the saved values and the autofocused field can select them.
  const openKey = isOpen ? activityName : null;
  const [prefilledKey, setPrefilledKey] = useState<ActivityName | null>(null);
  if (openKey !== prefilledKey) {
    setPrefilledKey(openKey);
    if (openKey) {
      setHours(currentHours > 0 ? currentHours.toString() : '');
      setNote(currentNote || '');
      setIsNoteExpanded(false);
      setError('');
    }
  }

  // Select the prefilled hours so typing replaces them instead of appending
  useLayoutEffect(() => {
    if (openKey) hoursInputRef.current?.select();
  }, [openKey]);

  // Focus note field when expanded via the chevron
  useEffect(() => {
    if (isNoteExpanded && noteInputRef.current) {
      noteInputRef.current.focus();
    }
  }, [isNoteExpanded]);

  if (!isOpen || !activityName) return null;

  // Get display name - use getActivityConfig for custom tiles
  const config = getActivityConfig(activityName, customTiles, colorOverrides);
  const displayName = config.label;
  const PredefinedIcon = typeof config.icon === 'string' ? null : (config.icon as LucideIcon);

  const parsedHours = parseHours(hours);
  const isValidHours =
    parsedHours !== null &&
    parsedHours >= 0 &&
    parsedHours <= MAX_HOURS &&
    isQuarterHour(parsedHours);
  const otherHours = Math.max(0, (dayTotalHours ?? 0) - currentHours);
  const remainingHours = Math.max(0, MAX_HOURS - otherHours);
  const exceedsDay =
    dayTotalHours !== undefined &&
    isValidHours &&
    parsedHours !== null &&
    parsedHours > remainingHours + 1e-9;
  // Counted in characters, as the server counts them, so each emoji counts once
  const noteLength = characterCount(note);

  const nudge = (delta: number) => {
    const base = parsedHours ?? 0;
    setHours(snapToStep(base + delta).toString());
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const numHours = parsedHours;
    if (numHours === null || numHours < 0 || numHours > MAX_HOURS) {
      setError('Please enter a valid number between 0 and 24');
      return;
    }

    if (!isQuarterHour(numHours)) {
      setError('Hours must be in increments of 0.25 (e.g., 0.25, 0.5, 0.75)');
      return;
    }

    setLoading(true);
    try {
      // Pass note only if it has content, otherwise pass undefined
      const trimmedNote = note.trim();
      await onSave(numHours, trimmedNote || undefined);
      onClose();
    } catch (err) {
      console.warn('[ActivityModal] Save failed; keeping the dialog open for retry', {
        activity: activityName,
      });
      setError(err instanceof Error ? err.message : 'Failed to save activity');
    } finally {
      setLoading(false);
    }
  };

  const hint = (() => {
    if (!hours.trim()) {
      return dayTotalHours !== undefined
        ? `${describeHours(remainingHours)} left to log for this day`
        : QUARTER_HOUR_HINT;
    }
    if (!isValidHours || parsedHours === null) return QUARTER_HOUR_HINT;
    if (parsedHours === 0) return 'Saving 0 clears this activity for the day';
    return `That's ${describeHours(parsedHours)}`;
  })();

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Log ${displayName}`}
      subtitle={date ? formatDayLabel(date) : undefined}
      icon={
        <span
          className={styles.activityIcon}
          style={{ '--activity-color': config.color } as React.CSSProperties}
        >
          {PredefinedIcon ? (
            <PredefinedIcon size={20} strokeWidth={2.25} />
          ) : (
            <DynamicIcon
              name={config.iconName || String(config.icon)}
              size={20}
              strokeWidth={2.25}
            />
          )}
        </span>
      }
      maxWidth="380px"
      mobileLayout="dialog"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            className={styles.footerButton}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={loading} className={styles.footerButton}>
            {loading ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className={styles.form} noValidate>
        {error && (
          <div id={errorId} role="alert" className={styles.error}>
            <AlertCircle size={16} strokeWidth={2.25} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.field}>
          <label htmlFor={hoursId} className={styles.label}>
            Hours
          </label>
          <div className={styles.stepper}>
            {DECREMENTS.map((delta) => (
              <button
                key={delta}
                type="button"
                className={styles.nudge}
                onClick={() => nudge(delta)}
                disabled={loading || (parsedHours ?? 0) <= 0}
                aria-label={`Subtract ${Math.abs(delta) * 60} minutes`}
              >
                −{Math.abs(delta) * 60}m
              </button>
            ))}
            <input
              ref={hoursInputRef}
              id={hoursId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              className={styles.hoursInput}
              value={hours}
              onChange={(e) => {
                setHours(e.target.value);
                if (error) setError('');
              }}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="0"
              autoFocus
              aria-invalid={!!error || undefined}
              aria-describedby={error ? `${errorId} ${hoursHintId}` : hoursHintId}
            />
            {INCREMENTS.map((delta) => (
              <button
                key={delta}
                type="button"
                className={styles.nudge}
                onClick={() => nudge(delta)}
                disabled={loading || (parsedHours ?? 0) >= MAX_HOURS}
                aria-label={`Add ${delta * 60} minutes`}
              >
                +{delta * 60}m
              </button>
            ))}
          </div>
          <p
            id={hoursHintId}
            className={`${styles.hint} ${exceedsDay ? styles.hintWarning : ''}`}
            aria-live="polite"
          >
            {exceedsDay ? (
              <>
                <AlertTriangle size={13} strokeWidth={2.5} aria-hidden="true" />
                Only {describeHours(remainingHours)} left in this day
              </>
            ) : (
              hint
            )}
          </p>
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor={noteId} className={styles.label}>
              Note <span className={styles.optional}>· optional</span>
            </label>
            <span
              className={`${styles.counter} ${noteLength > 0 ? styles.counterVisible : ''} ${
                noteLength >= NOTE_LIMIT ? styles.counterFull : ''
              }`}
              aria-hidden={noteLength === 0}
            >
              {noteLength}/{NOTE_LIMIT}
            </span>
          </div>
          <div className={styles.noteBox}>
            <textarea
              id={noteId}
              ref={noteInputRef}
              value={note}
              onChange={(e) => setNote(applyCharacterLimit(e.target.value, note, NOTE_LIMIT))}
              onFocus={() => setIsNoteExpanded(true)}
              placeholder="What did you get done?"
              rows={2}
              className={`${styles.note} ${isNoteExpanded ? styles.noteExpanded : ''}`}
            />
            {!isNoteExpanded && note.length > LONG_NOTE_CHARS && (
              <button
                type="button"
                className={styles.expandNote}
                onClick={() => setIsNoteExpanded(true)}
                aria-label="Show the full note"
              >
                <ChevronDown size={14} strokeWidth={2.5} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
};

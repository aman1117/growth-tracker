/**
 * CreateChallengeSheet
 *
 * The form for a new challenge: activity, goal ("at least" / "at most" N hours a day), length,
 * start date and title. The title follows the goal ("Study 2h+ a day") until the user edits it.
 * Dates are IST calendar dates, like everything the server compares with "today".
 *
 * On success the challenge joins the cached list and its page opens (with `created: true`, so
 * the page can suggest inviting friends).
 */

import { AlertCircle, Check, Minus, Plus, Trophy } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';

import { CHALLENGE_DURATION_OPTIONS, CHALLENGE_LIMITS } from '../../constants/challenges';
import { APP_ROUTES } from '../../constants/routes';
import { useOverlayAwareNavigate } from '../../hooks/useOverlayAwareNavigate';
import { challengeApi } from '../../services/api';
import { useChallengeStore } from '../../store';
import {
  ACTIVITY_NAMES,
  type ChallengeGoalType,
  type CreateChallengeRequest,
  type PredefinedActivityName,
} from '../../types';
import {
  addDays,
  clampTarget,
  formatDateRange,
  formatDayCount,
  formatHoursValue,
  formatRuleText,
  getChallengeActivityVisual,
  getChallengeErrorMessage,
  getIstToday,
  getStartDateBounds,
  getTargetError,
  getTargetRange,
  parseDateKey,
  parseHoursInput,
  suggestChallengeTitle,
} from '../../utils/challenges';
import { handleRovingKeyDown } from '../../utils/rovingFocus';
import { applyCharacterLimit, characterCount } from '../../utils/text';
import { Button, Input, Modal } from '../ui';
import { logChallengeFailure } from './challengeEffects';
import styles from './CreateChallengeSheet.module.css';

export interface ChallengeCreatedState {
  created: true;
}

interface CreateChallengeSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Today's IST date — the earliest start (defaults to the current IST date) */
  today?: string;
}

type StartOption = 'today' | 'tomorrow' | 'custom';

const DEFAULT_ACTIVITY: PredefinedActivityName = 'study';
const DEFAULT_DURATION_DAYS = 21;
const DEFAULT_TARGET_HOURS: Record<ChallengeGoalType, number> = { at_least: 2, at_most: 1 };
const STEP = CHALLENGE_LIMITS.HOURS_STEP;
const TITLE_MAX = CHALLENGE_LIMITS.TITLE_MAX_LENGTH;

const GOAL_OPTIONS: { value: ChallengeGoalType; label: string }[] = [
  { value: 'at_least', label: 'At least' },
  { value: 'at_most', label: 'At most' },
];

const START_OPTIONS: { value: StartOption; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'custom', label: 'Pick a date' },
];

/** A group of buttons that behaves like radio buttons (one Tab stop, arrow keys move) */
function RadioChips<T extends string | number>({
  labelledBy,
  options,
  value,
  onChange,
  className,
  renderOption,
}: {
  /** Id of the visible label */
  labelledBy: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className: string;
  renderOption?: (option: { value: T; label: string }, selected: boolean) => React.ReactNode;
}) {
  return (
    <div className={className} role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`${styles.chip} ${selected ? styles.chipSelected : ''}`}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) =>
              handleRovingKeyDown(event, index, (next) => onChange(options[next].value))
            }
          >
            {renderOption ? renderOption(option, selected) : option.label}
          </button>
        );
      })}
    </div>
  );
}

const CreateChallengeForm: React.FC<Omit<CreateChallengeSheetProps, 'isOpen'>> = ({
  onClose,
  today: todayProp,
}) => {
  const navigate = useOverlayAwareNavigate();
  const upsertFromDetail = useChallengeStore((state) => state.upsertFromDetail);
  const formId = useId();
  const activityLabelId = useId();
  const goalLabelId = useId();
  const lengthLabelId = useId();
  const startLabelId = useId();
  const targetId = useId();
  const targetHintId = useId();
  const titleId = useId();
  const titleCounterId = useId();
  const startDateId = useId();
  const errorId = useId();

  // Fixed while the sheet is open, so the form does not shift at midnight
  const [today] = useState(() => todayProp ?? getIstToday());
  const bounds = getStartDateBounds(today);

  const [activity, setActivity] = useState<PredefinedActivityName>(DEFAULT_ACTIVITY);
  const [goalType, setGoalType] = useState<ChallengeGoalType>('at_least');
  const [targetText, setTargetText] = useState(String(DEFAULT_TARGET_HOURS.at_least));
  const [targetTouched, setTargetTouched] = useState(false);
  const [showTargetError, setShowTargetError] = useState(false);
  const [duration, setDuration] = useState(DEFAULT_DURATION_DAYS);
  const [startOption, setStartOption] = useState<StartOption>('tomorrow');
  const [customDate, setCustomDate] = useState(() => addDays(today, 2));
  const [titleText, setTitleText] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const targetError = getTargetError(goalType, targetText);
  const targetHours = targetError === null ? (parseHoursInput(targetText) ?? 0) : null;
  const { min: minTarget, max: maxTarget } = getTargetRange(goalType);

  const suggestion = suggestChallengeTitle({
    activity,
    goal_type: goalType,
    target_hours: targetHours ?? DEFAULT_TARGET_HOURS[goalType],
  });
  const title = titleEdited ? titleText : suggestion;
  const titleError = title.trim() === '' ? 'Give your challenge a title' : null;

  const startDate =
    startOption === 'today' ? today : startOption === 'tomorrow' ? addDays(today, 1) : customDate;
  const startError =
    parseDateKey(startDate) && startDate >= bounds.min && startDate <= bounds.max
      ? null
      : 'Pick a start date within the next 30 days';
  const endDate = addDays(startDate, duration - 1);

  const clearServerError = () => setServerError(null);

  // A challenge being created cannot be abandoned half-way: it would open once created
  const handleClose = () => {
    if (!submittingRef.current) onClose();
  };

  const handleGoalChange = (next: ChallengeGoalType) => {
    if (next === goalType) return;
    setGoalType(next);
    clearServerError();
    if (!targetTouched) {
      setTargetText(String(DEFAULT_TARGET_HOURS[next]));
      return;
    }
    // Keep the user's target, moved into the new goal's range
    const typed = parseHoursInput(targetText);
    if (typed !== null) setTargetText(formatHoursValue(clampTarget(next, typed)));
  };

  const nudgeTarget = (direction: 1 | -1) => {
    const current = parseHoursInput(targetText) ?? DEFAULT_TARGET_HOURS[goalType];
    setTargetText(formatHoursValue(clampTarget(goalType, current + direction * STEP)));
    setTargetTouched(true);
    clearServerError();
  };

  const handleTargetBlur = () => {
    setShowTargetError(true);
    // Tidy a valid value, e.g. "1,50" → "1.5"
    if (targetError === null && targetHours !== null) setTargetText(formatHoursValue(targetHours));
  };

  const handleTitleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTitleText(applyCharacterLimit(event.target.value, title, TITLE_MAX));
    setTitleEdited(true);
    clearServerError();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    setSubmitted(true);
    setShowTargetError(true);

    if (targetError !== null || targetHours === null) {
      targetInputRef.current?.focus();
      return;
    }
    if (startError) {
      dateInputRef.current?.focus();
      return;
    }
    if (titleError) {
      titleInputRef.current?.focus();
      return;
    }

    const request: CreateChallengeRequest = {
      title: title.trim(),
      activity,
      goal_type: goalType,
      target_hours: targetHours,
      duration_days: duration,
      start_date: startDate,
    };

    submittingRef.current = true;
    setSubmitting(true);
    setServerError(null);
    try {
      const { challenge } = await challengeApi.create(request);
      upsertFromDetail(challenge);
      submittingRef.current = false;
      if (!mountedRef.current) return;
      const state: ChallengeCreatedState = { created: true };
      navigate(APP_ROUTES.CHALLENGE(challenge.id), { state });
      onClose();
    } catch (error) {
      logChallengeFailure('create_failed', error, {
        recovery: 'show_error',
        activity,
        durationDays: duration,
      });
      submittingRef.current = false;
      if (!mountedRef.current) return;
      setServerError(getChallengeErrorMessage(error, 'create'));
      setSubmitting(false);
    }
  };

  const titleCount = characterCount(title);
  const showTargetProblem = showTargetError && targetError !== null;

  return (
    <Modal
      isOpen
      onClose={handleClose}
      title="New challenge"
      subtitle="Everyone's logged hours count automatically"
      icon={<Trophy size={20} />}
      mobileLayout="dialog"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={submitting}
            className={styles.footerButton}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={submitting} className={styles.footerButton}>
            {submitting ? 'Creating…' : 'Create challenge'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={styles.form}
        onSubmit={handleSubmit}
        noValidate
        aria-describedby={serverError ? errorId : undefined}
      >
        {serverError && (
          <div id={errorId} className={styles.error} role="alert">
            <AlertCircle size={16} strokeWidth={2.25} aria-hidden="true" />
            <span>{serverError}</span>
          </div>
        )}

        <div className={styles.field}>
          <span id={activityLabelId} className={styles.label}>
            Activity
          </span>
          <RadioChips
            labelledBy={activityLabelId}
            className={styles.activities}
            options={ACTIVITY_NAMES.map((name) => ({
              value: name,
              label: getChallengeActivityVisual(name).label,
            }))}
            value={activity}
            onChange={(next) => {
              setActivity(next);
              clearServerError();
            }}
            renderOption={(option, selected) => {
              const { Icon, color } = getChallengeActivityVisual(option.value);
              return (
                <span
                  className={styles.activityOption}
                  style={{ '--activity-color': color } as React.CSSProperties}
                >
                  <span className={styles.activityIcon} aria-hidden="true">
                    {selected ? (
                      <Check size={15} strokeWidth={3} />
                    ) : (
                      <Icon size={15} strokeWidth={2.3} />
                    )}
                  </span>
                  {option.label}
                </span>
              );
            }}
          />
        </div>

        <div className={styles.field}>
          <span id={goalLabelId} className={styles.label}>
            Daily goal
          </span>
          <RadioChips
            labelledBy={goalLabelId}
            className={styles.segmented}
            options={GOAL_OPTIONS}
            value={goalType}
            onChange={handleGoalChange}
          />
          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.nudge}
              onClick={() => nudgeTarget(-1)}
              disabled={targetHours !== null && targetHours <= minTarget}
              aria-label="Decrease daily target by 15 minutes"
            >
              <Minus size={18} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <div
              className={`${styles.targetBox} ${showTargetProblem ? styles.targetBoxError : ''}`}
            >
              <input
                ref={targetInputRef}
                id={targetId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="done"
                className={styles.targetInput}
                value={targetText}
                onChange={(event) => {
                  setTargetText(event.target.value);
                  setTargetTouched(true);
                  clearServerError();
                }}
                onBlur={handleTargetBlur}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Daily target in hours"
                aria-invalid={showTargetProblem || undefined}
                aria-describedby={targetHintId}
              />
              <span className={styles.targetUnit} aria-hidden="true">
                h
              </span>
            </div>
            <button
              type="button"
              className={styles.nudge}
              onClick={() => nudgeTarget(1)}
              disabled={targetHours !== null && targetHours >= maxTarget}
              aria-label="Increase daily target by 15 minutes"
            >
              <Plus size={18} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
          <p
            id={targetHintId}
            className={`${styles.hint} ${showTargetProblem ? styles.hintError : ''}`}
            role={showTargetProblem ? 'alert' : undefined}
          >
            {showTargetProblem
              ? targetError
              : formatRuleText({
                  activity,
                  goal_type: goalType,
                  target_hours: targetHours ?? DEFAULT_TARGET_HOURS[goalType],
                })}
          </p>
        </div>

        <div className={styles.field}>
          <span id={lengthLabelId} className={styles.label}>
            Length
          </span>
          <RadioChips
            labelledBy={lengthLabelId}
            className={styles.chipRow}
            options={CHALLENGE_DURATION_OPTIONS.map((days) => ({
              value: days,
              label: formatDayCount(days),
            }))}
            value={duration}
            onChange={(next) => {
              setDuration(next);
              clearServerError();
            }}
          />
        </div>

        <div className={styles.field}>
          <span id={startLabelId} className={styles.label}>
            Start
          </span>
          <RadioChips
            labelledBy={startLabelId}
            className={styles.chipRow}
            options={START_OPTIONS}
            value={startOption}
            onChange={(next) => {
              setStartOption(next);
              clearServerError();
            }}
          />
          {startOption === 'custom' && (
            <Input
              ref={dateInputRef}
              id={startDateId}
              type="date"
              label="Start date"
              min={bounds.min}
              max={bounds.max}
              value={customDate}
              onChange={(event) => {
                setCustomDate(event.target.value);
                clearServerError();
              }}
              error={startError ?? undefined}
            />
          )}
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor={titleId} className={styles.label}>
              Title
            </label>
            <span
              id={titleCounterId}
              className={`${styles.counter} ${titleCount >= TITLE_MAX ? styles.counterFull : ''}`}
            >
              <span className="sr-only">Characters used: </span>
              {titleCount}/{TITLE_MAX}
            </span>
          </div>
          <Input
            ref={titleInputRef}
            id={titleId}
            type="text"
            autoComplete="off"
            enterKeyHint="done"
            value={title}
            onChange={handleTitleChange}
            aria-describedby={titleCounterId}
            error={submitted && titleError ? titleError : undefined}
          />
        </div>

        <p className={styles.summary} aria-live="polite">
          {startError ? 'Pick a start date' : formatDateRange(startDate, endDate)} ·{' '}
          {formatDayCount(duration)}
        </p>
      </form>
    </Modal>
  );
};
export const CreateChallengeSheet: React.FC<CreateChallengeSheetProps> = ({ isOpen, ...props }) =>
  // Mounted only while open, so every opening starts from a fresh form
  isOpen ? <CreateChallengeForm {...props} /> : null;

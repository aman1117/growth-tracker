import { Flame } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api } from '../services/api';
import styles from './StreakCard.module.css';

interface StreakCardProps {
  username: string;
  date: string; // YYYY-MM-DD
}

interface StreakData {
  current: number;
  longest: number;
}

export const StreakCard: React.FC<StreakCardProps> = ({ username, date }) => {
  const [streak, setStreak] = useState<StreakData>({ current: 0, longest: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStreak = async () => {
      setLoading(true);
      try {
        const res = await api.post('/get-streak', {
          username,
          date,
        });
        if (res.success && res.data) {
          setStreak({
            current: res.data.current,
            longest: res.data.longest,
          });
        } else {
          setStreak({ current: 0, longest: 0 });
        }
      } catch (error) {
        console.error('Failed to fetch streak:', error);
        setStreak({ current: 0, longest: 0 });
      } finally {
        setLoading(false);
      }
    };

    fetchStreak();
  }, [username, date]);

  if (loading) {
    return <div className={`skeleton ${styles.skeleton}`} />;
  }

  const isToday = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}` === date;
  };

  const showCurrentStreak = isToday();

  return (
    <div className={styles.card}>
      {showCurrentStreak && (
        <>
          <div className={styles.streakItem}>
            <div className={styles.iconCircle}>
              <Flame size={18} />
            </div>
            <span className={styles.streakText}>Current Streak: {streak.current}</span>
          </div>
          <span className={`${styles.divider} ${styles.mobileDivider}`}>|</span>
        </>
      )}
      <div className={styles.streakItem}>
        <span className={styles.streakText}>Longest Streak: {streak.longest}</span>
      </div>
    </div>
  );
};

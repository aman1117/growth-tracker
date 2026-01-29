import { ChevronLeft, ChevronRight } from 'lucide-react';
import React from 'react';

interface DateNavigatorProps {
  currentDate: Date;
  onPrev: () => void;
  onNext: () => void;
  isNextDisabled: boolean;
}

export const DateNavigator: React.FC<DateNavigatorProps> = ({
  currentDate,
  onPrev,
  onNext,
  isNextDisabled,
}) => {
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="flex justify-between items-center mb-4 card" style={{ padding: '1rem' }}>
      <button
        onClick={onPrev}
        className="btn-outline"
        style={{ padding: '0.5rem', border: 'none' }}
      >
        <ChevronLeft size={24} />
      </button>
      <h2 style={{ fontSize: '1.1rem', textAlign: 'center' }}>
        {formatDate(currentDate).toUpperCase()}
      </h2>
      <button
        onClick={onNext}
        disabled={isNextDisabled}
        className="btn-outline"
        style={{
          padding: '0.5rem',
          border: 'none',
          opacity: isNextDisabled ? 0.3 : 1,
          cursor: isNextDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        <ChevronRight size={24} />
      </button>
    </div>
  );
};

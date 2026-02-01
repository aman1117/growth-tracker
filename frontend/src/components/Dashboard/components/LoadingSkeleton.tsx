/**
 * LoadingSkeleton Component
 *
 * Displays a skeleton loading state for the dashboard tiles.
 */

import React from 'react';

export const LoadingSkeleton: React.FC = () => {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gridAutoRows: '100px',
        gap: '8px',
        padding: '8px',
      }}
    >
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="skeleton-glass"
          style={{
            gridColumn: i < 2 ? 'span 2' : 'span 1',
            gridRow: i === 0 ? 'span 2' : 'span 1',
            width: '100%',
            height: '100%',
            borderRadius: '24px',
            background: 'var(--tile-glass-bg)',
            backdropFilter: 'blur(var(--tile-glass-blur))',
            WebkitBackdropFilter: 'blur(var(--tile-glass-blur))',
            border: '1px solid var(--tile-glass-border)',
            boxShadow: 'var(--tile-glass-shadow), var(--tile-glass-inner-glow)',
          }}
        />
      ))}
    </div>
  );
};

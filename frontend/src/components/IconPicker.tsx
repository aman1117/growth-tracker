/**
 * IconPicker Component
 *
 * An icon picker with categorized icons.
 * Glassmorphism styled to match app theme.
 */

import { Check } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { ALL_ICONS, ICON_CATEGORIES, type IconCategory } from '../constants/icons';
import { DynamicIcon } from './DynamicIcon';

interface IconPickerProps {
  value: string;
  onChange: (iconName: string) => void;
  color?: string;
}

export const IconPicker: React.FC<IconPickerProps> = ({
  value,
  onChange,
  color = 'var(--text-primary)',
}) => {
  const [selectedCategory, setSelectedCategory] = useState<IconCategory>('All');

  // Filter icons based on category
  const filteredIcons = useMemo(() => {
    if (selectedCategory === 'All') {
      return ALL_ICONS;
    }
    return [...ICON_CATEGORIES[selectedCategory]];
  }, [selectedCategory]);

  const handleIconClick = useCallback(
    (iconName: string) => {
      onChange(iconName);
    },
    [onChange]
  );

  const categories = ['All', ...Object.keys(ICON_CATEGORIES)] as IconCategory[];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <style>{`
                .hide-scrollbar::-webkit-scrollbar {
                    display: none;
                }
            `}</style>

      {/* Category Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '4px',
          overflowX: 'auto',
          paddingBottom: '2px',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
        className="hide-scrollbar"
      >
        {categories.map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => setSelectedCategory(category as typeof selectedCategory)}
            style={{
              padding: '5px 10px',
              background: selectedCategory === category ? 'var(--accent)' : 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '14px',
              color: selectedCategory === category ? 'white' : 'var(--text-secondary)',
              fontSize: '0.7rem',
              fontWeight: selectedCategory === category ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s ease',
            }}
          >
            {category}
          </button>
        ))}
      </div>

      {/* Icons Grid */}
      <div
        className="hide-scrollbar"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '6px',
          maxHeight: '150px',
          overflowY: 'auto',
          padding: '6px',
          background: 'var(--bg-secondary)',
          borderRadius: '10px',
          border: '1px solid var(--border)',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {filteredIcons.length === 0 ? (
          <div
            style={{
              gridColumn: '1 / -1',
              textAlign: 'center',
              padding: '16px',
              color: 'var(--text-tertiary)',
              fontSize: '0.8rem',
            }}
          >
            No icons found
          </div>
        ) : (
          filteredIcons.map((iconName) => (
            <button
              key={iconName}
              type="button"
              onClick={() => handleIconClick(iconName)}
              title={iconName}
              style={{
                width: '38px',
                height: '38px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: value === iconName ? `${color}20` : 'transparent',
                border: value === iconName ? `2px solid ${color}` : '2px solid transparent',
                borderRadius: '8px',
                cursor: 'pointer',
                position: 'relative',
                transition: 'all 0.15s ease',
              }}
            >
              <DynamicIcon
                name={iconName}
                size={20}
                color={value === iconName ? color : 'var(--text-secondary)'}
              />
              {value === iconName && (
                <div
                  style={{
                    position: 'absolute',
                    top: '-3px',
                    right: '-3px',
                    width: '14px',
                    height: '14px',
                    borderRadius: '50%',
                    background: color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Check size={8} color="white" strokeWidth={3} />
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
};

export default IconPicker;

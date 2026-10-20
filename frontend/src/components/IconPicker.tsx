/**
 * IconPicker Component
 *
 * Categorized icon grid for custom tiles. Category chips filter the grid; the
 * grid is a single-select radio group (one Tab stop, arrow keys move).
 */

import { Check } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { ALL_ICONS, ICON_CATEGORIES, type IconCategory } from '../constants/icons';
import { getOnColorTone, hexToRgb } from '../utils/color';
import { handleRovingKeyDown } from '../utils/rovingFocus';
import { DynamicIcon } from './DynamicIcon';
import styles from './IconPicker.module.css';

interface IconPickerProps {
  value: string;
  onChange: (iconName: string) => void;
  color?: string;
}

const CATEGORIES = ['All', ...Object.keys(ICON_CATEGORIES)] as IconCategory[];

/** "Gamepad2" → "Gamepad 2", "BookOpen" → "Book open" */
const humanizeIconName = (name: string): string =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .split(' ')
    .map((word, index) => (index === 0 ? word : word.toLowerCase()))
    .join(' ');

export const IconPicker: React.FC<IconPickerProps> = ({
  value,
  onChange,
  color = 'var(--accent)',
}) => {
  const [selectedCategory, setSelectedCategory] = useState<IconCategory>('All');
  const gridRef = useRef<HTMLDivElement>(null);

  // Filter icons based on category
  const filteredIcons = useMemo<string[]>(() => {
    if (selectedCategory === 'All') {
      return [...ALL_ICONS];
    }
    return [...ICON_CATEGORIES[selectedCategory]];
  }, [selectedCategory]);

  const selectedIndex = filteredIcons.indexOf(value);
  // CSS colors (e.g. var(--accent)) can't be measured; assume a deep color
  const checkTone = hexToRgb(color) ? getOnColorTone(color) : 'light';

  // Bring the current icon into view inside the grid (without scrolling the page)
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const selected = grid.querySelector<HTMLElement>('[aria-checked="true"]');
    grid.scrollTop = selected
      ? Math.max(0, selected.offsetTop - grid.clientHeight / 2 + selected.offsetHeight / 2)
      : 0;
    // Only when the category changes; arrow keys keep focus in view natively
  }, [selectedCategory]);

  return (
    <div className={styles.picker} style={{ '--icon-color': color } as React.CSSProperties}>
      {/* Category filter */}
      <div className={styles.categories} role="group" aria-label="Icon categories">
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className={`${styles.category} ${
              selectedCategory === category ? styles.categoryActive : ''
            }`}
            aria-pressed={selectedCategory === category}
            onClick={() => setSelectedCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>

      {/* Icons Grid */}
      {filteredIcons.length === 0 ? (
        <div className={styles.empty}>No icons found</div>
      ) : (
        <div ref={gridRef} className={styles.grid} role="radiogroup" aria-label="Icons">
          {filteredIcons.map((iconName, index) => {
            const selected = index === selectedIndex;
            const isTabStop = selectedIndex === -1 ? index === 0 : selected;
            const label = humanizeIconName(iconName);
            return (
              <button
                key={iconName}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                title={label}
                tabIndex={isTabStop ? 0 : -1}
                className={`${styles.iconButton} ${selected ? styles.iconSelected : ''}`}
                onClick={() => onChange(iconName)}
                onKeyDown={(e) =>
                  handleRovingKeyDown(e, index, (next) => onChange(filteredIcons[next]))
                }
              >
                <DynamicIcon name={iconName} size={20} strokeWidth={2} aria-hidden="true" />
                {selected && (
                  <span
                    className={`${styles.checkBadge} ${checkTone === 'dark' ? styles.checkBadgeDark : ''}`}
                    aria-hidden="true"
                  >
                    <Check size={9} strokeWidth={3.5} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default IconPicker;

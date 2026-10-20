/**
 * LoadingSkeleton Component
 *
 * Skeleton for the dashboard tile grid. Shares TileGrid's grid so the layout
 * doesn't jump when real tiles arrive.
 */

import React from 'react';

import { Skeleton } from '../../ui';
import gridStyles from './TileGrid.module.css';

/** A plausible default layout: one large tile, one wide tile, then small tiles */
const SKELETON_TILES = [
  { column: 'span 2', row: 'span 2' },
  { column: 'span 2', row: 'span 1' },
  { column: 'span 1', row: 'span 1' },
  { column: 'span 1', row: 'span 1' },
  { column: 'span 1', row: 'span 1' },
  { column: 'span 1', row: 'span 1' },
  { column: 'span 1', row: 'span 1' },
  { column: 'span 1', row: 'span 1' },
];

export const LoadingSkeleton: React.FC = () => {
  return (
    <div className={gridStyles.grid} aria-busy="true" aria-label="Loading activities">
      {SKELETON_TILES.map((tile, i) => (
        <div key={i} style={{ gridColumn: tile.column, gridRow: tile.row }}>
          <Skeleton width="100%" height="100%" radius="xl" glass />
        </div>
      ))}
    </div>
  );
};

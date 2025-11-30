import React from 'react';
import type { ActivityName } from '../types';
import type { LucideIcon } from 'lucide-react';

interface ActivityTileProps {
    name: ActivityName;
    hours: number;
    onClick: () => void;
    icon: LucideIcon;
    color: string;
}

export const ActivityTile: React.FC<ActivityTileProps> = ({ name, hours, onClick, icon: Icon, color }) => {
    const isActive = hours > 0;

    // Format name (e.g., book_reading -> Book Reading)
    const displayName = name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    return (
        <div
            onClick={onClick}
            style={{
                backgroundColor: isActive ? `${color}15` : 'transparent',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                padding: '0.5rem',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                aspectRatio: '1',
                transition: 'all 0.2s',
                position: 'relative',
                borderRadius: '0',
            }}
            className="activity-tile"
        >
            <Icon
                size={32}
                color={isActive ? color : 'var(--text-secondary)'}
                style={{ marginBottom: '0.5rem', transition: 'color 0.2s' }}
            />

            <span style={{
                fontSize: '0.75rem',
                textAlign: 'center',
                fontWeight: 600,
                color: isActive ? color : 'var(--text-secondary)',
                lineHeight: 1.2,
                wordBreak: 'break-word',
                hyphens: 'auto'
            }}>
                {displayName}
            </span>
            {isActive && (
                <span style={{
                    marginTop: '0.25rem',
                    fontSize: '1rem',
                    fontWeight: 700,
                    color: 'var(--text-primary)'
                }}>
                    {hours}h
                </span>
            )}
        </div>
    );
};

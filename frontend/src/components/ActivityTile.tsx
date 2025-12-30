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
            {/* Duotone Icon Container */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '52px',
                    height: '52px',
                    borderRadius: '50%',
                    backgroundColor: isActive ? `${color}12` : 'var(--border)',
                    marginBottom: '0.5rem',
                    transition: 'background-color 0.2s',
                }}
            >
                <Icon
                    size={26}
                    color={isActive ? color : 'var(--text-secondary)'}
                    style={{ transition: 'color 0.2s' }}
                />
            </div>

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
            <span style={{
                marginTop: '0.25rem',
                fontSize: '1rem',
                fontWeight: 700,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)'
            }}>
                {hours}h
            </span>
        </div>
    );
};

import React from 'react';
import { Clock, CheckCircle2, AlertCircle } from 'lucide-react';

interface HoursSummaryProps {
    activities: Record<string, number>;
    loading?: boolean;
}

export const HoursSummary: React.FC<HoursSummaryProps> = ({ activities, loading = false }) => {
    const totalHours = Object.values(activities).reduce<number>((sum, hours) => sum + hours, 0);
    const maxHours = 24;
    const percentage = Math.min((totalHours / maxHours) * 100, 100);
    const remainingHours = Math.max(maxHours - totalHours, 0);

    const getStatusColor = () => {
        if (totalHours >= maxHours) return 'var(--success)';
        if (totalHours >= 18) return 'var(--accent)';
        return 'var(--text-secondary)';
    };

    const getStatusIcon = () => {
        if (totalHours >= maxHours) return CheckCircle2;
        if (totalHours > maxHours) return AlertCircle;
        return Clock;
    };

    const StatusIcon = getStatusIcon();

    if (loading) {
        return (
            <div
                className="skeleton"
                style={{
                    height: '80px',
                    marginBottom: '1rem',
                    borderRadius: '8px',
                }}
            />
        );
    }

    return (
        <div
            style={{
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '1rem 1.25rem',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                transition: 'background-color 0.3s ease, border-color 0.3s ease',
            }}
        >
            {/* Icon */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '48px',
                    height: '48px',
                    backgroundColor: 'var(--icon-bg-muted)',
                    borderRadius: '50%',
                    flexShrink: 0,
                    transition: 'all 0.3s ease',
                }}
            >
                <StatusIcon size={24} color={getStatusColor()} />
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        marginBottom: '0.5rem',
                    }}
                >
                    <span
                        style={{
                            fontSize: '0.875rem',
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                        }}
                    >
                        Hours Logged
                    </span>
                    <span
                        style={{
                            fontSize: '1.25rem',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                        }}
                    >
                        {totalHours}
                        <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                            /{maxHours}h
                        </span>
                    </span>
                </div>

                {/* Progress Bar */}
                <div
                    style={{
                        width: '100%',
                        height: '6px',
                        backgroundColor: 'var(--progress-track)',
                        borderRadius: '3px',
                        overflow: 'hidden',
                        transition: 'background-color 0.3s ease',
                    }}
                >
                    <div
                        style={{
                            width: `${percentage}%`,
                            height: '100%',
                            backgroundColor: getStatusColor(),
                            borderRadius: '3px',
                            transition: 'width 0.3s ease, background-color 0.3s ease',
                        }}
                    />
                </div>

                {/* Status Text */}
                <div
                    style={{
                        marginTop: '0.375rem',
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                    }}
                >
                    {totalHours >= maxHours ? (
                        <span style={{ color: 'var(--success)', fontWeight: 600 }}>
                            ✓ Day fully logged
                        </span>
                    ) : totalHours > maxHours ? (
                        <span style={{ color: 'var(--error)', fontWeight: 600 }}>
                            ⚠ Over 24 hours logged
                        </span>
                    ) : (
                        <span>{remainingHours}h remaining to log</span>
                    )}
                </div>
            </div>
        </div>
    );
};

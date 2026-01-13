import React from 'react';
import { useSpring, animated } from '@react-spring/web';

interface GrowthSpinnerProps {
    /** Pull progress from 0 to 1 (mapped from 0-80px pull distance) */
    progress: number;
    /** Whether refresh is actively in progress */
    isRefreshing: boolean;
    /** Size of the spinner in pixels */
    size?: number;
}

// Subtle gradient colors (Instagram-inspired)
const GRADIENT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899'];

/**
 * GrowthSpinner - Subtle Instagram-style pull-to-refresh indicator
 * 
 * Features a simple circular progress that:
 * - Fills as user pulls down (arc progress)
 * - Rotates continuously during refresh
 * - Clean, minimal design
 */
export const GrowthSpinner: React.FC<GrowthSpinnerProps> = ({
    progress,
    isRefreshing,
    size = 32,
}) => {
    // Rotation animation during refresh
    const rotationSpring = useSpring({
        from: { rotate: 0 },
        to: { rotate: isRefreshing ? 360 : progress * 360 },
        loop: isRefreshing,
        config: { duration: isRefreshing ? 800 : 100 },
        reset: isRefreshing,
        immediate: !isRefreshing,
    });

    // Scale animation
    const scaleSpring = useSpring({
        scale: isRefreshing ? 1 : Math.max(0.6, progress),
        opacity: isRefreshing ? 1 : Math.max(0.4, progress),
        config: { tension: 300, friction: 20 },
    });

    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const center = size / 2;

    // Arc progress (how much of the circle is filled) - full circle when complete
    const arcProgress = isRefreshing ? 0.3 : progress;

    return (
        <animated.div
            style={{
                width: size,
                height: size,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: scaleSpring.opacity,
                transform: scaleSpring.scale.to(s => `scale(${s})`),
            }}
        >
            <animated.svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={{
                    transform: rotationSpring.rotate.to(r => `rotate(${r}deg)`),
                }}
            >
                <defs>
                    <linearGradient id="spinnerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        {GRADIENT_COLORS.map((color, i) => (
                            <stop
                                key={i}
                                offset={`${(i / (GRADIENT_COLORS.length - 1)) * 100}%`}
                                stopColor={color}
                            />
                        ))}
                    </linearGradient>
                </defs>

                {/* Background track */}
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={strokeWidth}
                    opacity={0.3}
                />

                {/* Progress arc */}
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke="url(#spinnerGradient)"
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeDasharray={`${circumference * arcProgress} ${circumference}`}
                    strokeDashoffset={circumference * 0.25}
                    style={{
                        transition: isRefreshing ? 'none' : 'stroke-dasharray 0.1s ease-out',
                    }}
                />
            </animated.svg>
        </animated.div>
    );
};

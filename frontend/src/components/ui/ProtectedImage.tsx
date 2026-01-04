import React from 'react';

interface ProtectedImageProps {
    src: string;
    alt: string;
    style?: React.CSSProperties;
    className?: string;
}

/**
 * A protected image component that prevents easy downloading.
 * - Disables right-click context menu (desktop)
 * - Disables long-press save menu (iOS Safari)
 * - Prevents drag and drop
 * - Disables pointer events on the image itself (unless overridden via style)
 */
export const ProtectedImage: React.FC<ProtectedImageProps> = ({
    src,
    alt,
    style,
    className
}) => {
    return (
        <img
            src={src}
            alt={alt}
            className={className}
            style={{
                WebkitUserSelect: 'none',
                userSelect: 'none',
                pointerEvents: 'none',
                WebkitTouchCallout: 'none', // iOS Safari: prevents long-press menu
                ...style, // Allow style overrides (e.g., pointerEvents: 'auto' for clickable images)
            }}
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
        />
    );
};

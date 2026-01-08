/**
 * IconPicker Component
 * 
 * A large, searchable icon picker with categorized icons.
 * Glassmorphism styled to match app theme.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Search, Check } from 'lucide-react';
import { DynamicIcon } from './DynamicIcon';

// Curated icon categories with ~100 useful icons for activities
export const ICON_CATEGORIES = {
    'Activities': [
        'Bike', 'Dumbbell', 'Music', 'Gamepad2', 'Palette', 'Camera', 'Headphones',
        'Guitar', 'Mic', 'Footprints', 'Mountain', 'Tent', 'Fish', 'Bird', 'Dog', 'Cat',
    ],
    'Work': [
        'Briefcase', 'Laptop', 'Code', 'PenTool', 'Building', 'Monitor', 'Keyboard',
        'FileText', 'FolderOpen', 'Mail', 'Send', 'Phone', 'Video',
        'Calendar', 'Clock', 'Timer', 'Target', 'Flag', 'Award', 'Trophy',
    ],
    'Lifestyle': [
        'Coffee', 'Wine', 'Utensils', 'ShoppingBag', 'ShoppingCart', 'Gift', 'Shirt',
        'Scissors', 'Gem', 'Crown', 'Star', 'Heart', 'Smile', 'Meh', 'Frown',
        'ThumbsUp', 'PartyPopper', 'Cake', 'Cookie', 'Pizza', 'Apple',
    ],
    'Wellness': [
        'Moon', 'Sun', 'CloudSun', 'Sunrise', 'Brain', 'Eye', 'Ear',
        'Activity', 'Pill', 'Stethoscope', 'Thermometer', 'Droplet', 'Leaf', 'Flower',
        'TreePine', 'Sprout', 'Wind', 'Waves', 'Flame', 'Snowflake', 'Zap',
    ],
    'Social': [
        'Users', 'UserPlus', 'MessageCircle', 'MessagesSquare', 'AtSign', 'Share2',
        'Link', 'Globe', 'MapPin', 'Navigation', 'Compass', 'Home', 'Building2',
        'Church', 'Landmark', 'School', 'GraduationCap', 'BookOpen', 'Library',
    ],
    'Travel': [
        'Plane', 'Car', 'Train', 'Bus', 'Ship', 'Anchor', 'Map', 'Luggage',
        'Ticket', 'Hotel', 'Bed', 'Sofa', 'Armchair', 'Lamp', 'Tv', 'Radio',
        'Wifi', 'Battery', 'Plug', 'Power', 'Lightbulb',
    ],
} as const;

// Flatten all icons for search
const ALL_ICONS = Object.values(ICON_CATEGORIES).flat();

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
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<keyof typeof ICON_CATEGORIES | 'All'>('All');

    // Filter icons based on search and category
    const filteredIcons = useMemo(() => {
        let icons: string[];
        
        if (selectedCategory === 'All') {
            icons = ALL_ICONS;
        } else {
            icons = [...ICON_CATEGORIES[selectedCategory]];
        }

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            icons = icons.filter(icon => 
                icon.toLowerCase().includes(query)
            );
        }

        return icons;
    }, [selectedCategory, searchQuery]);

    const handleIconClick = useCallback((iconName: string) => {
        onChange(iconName);
    }, [onChange]);

    const categories = ['All', ...Object.keys(ICON_CATEGORIES)] as const;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
        }}>
            <style>{`
                .hide-scrollbar::-webkit-scrollbar {
                    display: none;
                }
            `}</style>
            {/* Search Input */}
            <div style={{
                position: 'relative',
            }}>
                <Search 
                    size={18} 
                    style={{
                        position: 'absolute',
                        left: '12px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: 'var(--text-tertiary)',
                    }}
                />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search icons..."
                    style={{
                        width: '100%',
                        padding: '10px 12px 10px 40px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: '10px',
                        color: 'var(--text-primary)',
                        fontSize: '16px',
                        outline: 'none',
                        boxSizing: 'border-box',
                    }}
                />
            </div>

            {/* Category Tabs */}
            <div style={{
                display: 'flex',
                gap: '6px',
                overflowX: 'auto',
                paddingBottom: '4px',
                WebkitOverflowScrolling: 'touch',
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
            }}
            className="hide-scrollbar">
                {categories.map((category) => (
                    <button
                        key={category}
                        type="button"
                        onClick={() => setSelectedCategory(category as typeof selectedCategory)}
                        style={{
                            padding: '6px 12px',
                            background: selectedCategory === category 
                                ? 'var(--accent)'
                                : 'var(--bg-secondary)',
                            border: '1px solid var(--border)',
                            borderRadius: '16px',
                            color: selectedCategory === category 
                                ? 'white'
                                : 'var(--text-secondary)',
                            fontSize: '0.75rem',
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
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: '8px',
                maxHeight: '240px',
                overflowY: 'auto',
                padding: '4px',
                background: 'var(--bg-secondary)',
                borderRadius: '12px',
                border: '1px solid var(--border)',
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
            }}>
                {filteredIcons.length === 0 ? (
                    <div style={{
                        gridColumn: '1 / -1',
                        textAlign: 'center',
                        padding: '24px',
                        color: 'var(--text-tertiary)',
                        fontSize: '0.85rem',
                    }}>
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
                                width: '44px',
                                height: '44px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: value === iconName 
                                    ? `${color}20`
                                    : 'transparent',
                                border: value === iconName 
                                    ? `2px solid ${color}`
                                    : '2px solid transparent',
                                borderRadius: '10px',
                                cursor: 'pointer',
                                position: 'relative',
                                transition: 'all 0.15s ease',
                            }}
                        >
                            <DynamicIcon 
                                name={iconName} 
                                size={22}
                                color={value === iconName ? color : 'var(--accent)'}
                            />
                            {value === iconName && (
                                <div style={{
                                    position: 'absolute',
                                    top: '-4px',
                                    right: '-4px',
                                    width: '16px',
                                    height: '16px',
                                    borderRadius: '50%',
                                    background: color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}>
                                    <Check size={10} color="white" strokeWidth={3} />
                                </div>
                                )}
                            </button>
                        ))
                    )}
            </div>

            {/* Selected Icon Preview */}
            {value && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '12px',
                    background: `linear-gradient(135deg, ${color}15 0%, ${color}05 100%)`,
                    border: `1px solid ${color}30`,
                    borderRadius: '12px',
                }}>
                    <div style={{
                        width: '48px',
                        height: '48px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: `${color}20`,
                        borderRadius: '12px',
                    }}>
                        <DynamicIcon name={value} size={28} color={color} />
                    </div>
                    <div>
                        <div style={{
                            fontSize: '0.85rem',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                        }}>
                            {value}
                        </div>
                        <div style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-tertiary)',
                        }}>
                            Selected icon
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default IconPicker;

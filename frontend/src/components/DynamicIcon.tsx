/**
 * DynamicIcon Component
 * 
 * Renders Lucide icons by name using a pre-imported icon map.
 * This approach is more reliable than dynamic imports with Vite.
 */

import React, { memo } from 'react';
import type { LucideProps } from 'lucide-react';
import {
    // Activities
    Bike, Dumbbell, Music, Gamepad2, Palette, Camera, Headphones,
    Guitar, Mic, Footprints, Mountain, Tent, Fish, Bird, Dog, Cat,
    // Work
    Briefcase, Laptop, Code, PenTool, Building, Monitor, Keyboard,
    FileText, FolderOpen, Mail, Send, Phone, Video,
    Calendar, Clock, Timer, Target, Flag, Award, Trophy,
    // Lifestyle
    Coffee, Wine, Utensils, ShoppingBag, ShoppingCart, Gift, Shirt,
    Scissors, Gem, Crown, Star, Heart, Smile, Meh, Frown,
    ThumbsUp, PartyPopper, Cake, Cookie, Pizza, Apple,
    // Wellness
    Moon, Sun, CloudSun, Sunrise, Brain, Eye, Ear,
    Activity, Pill, Stethoscope, Thermometer, Droplet, Leaf, Flower,
    TreePine, Sprout, Wind, Waves, Flame, Snowflake, Zap,
    // Social
    Users, UserPlus, MessageCircle, MessagesSquare, AtSign, Share2,
    Link, Globe, MapPin, Navigation, Compass, Home, Building2,
    Church, Landmark, School, GraduationCap, BookOpen, Library,
    // Travel
    Plane, Car, Train, Bus, Ship, Anchor, Map, Luggage,
    Ticket, Hotel, Bed, Sofa, Armchair, Lamp, Tv, Radio,
    Wifi, Battery, Plug, Power, Lightbulb,
    // Default fallback
    Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Map of icon names to their components
const ICON_MAP: Record<string, LucideIcon> = {
    // Activities
    Bike, Dumbbell, Music, Gamepad2, Palette, Camera, Headphones,
    Guitar, Mic, Footprints, Mountain, Tent, Fish, Bird, Dog, Cat,
    // Work
    Briefcase, Laptop, Code, PenTool, Building, Monitor, Keyboard,
    FileText, FolderOpen, Mail, Send, Phone, Video,
    Calendar, Clock, Timer, Target, Flag, Award, Trophy,
    // Lifestyle
    Coffee, Wine, Utensils, ShoppingBag, ShoppingCart, Gift, Shirt,
    Scissors, Gem, Crown, Star, Heart, Smile, Meh, Frown,
    ThumbsUp, PartyPopper, Cake, Cookie, Pizza, Apple,
    // Wellness
    Moon, Sun, CloudSun, Sunrise, Brain, Eye, Ear,
    Activity, Pill, Stethoscope, Thermometer, Droplet, Leaf, Flower,
    TreePine, Sprout, Wind, Waves, Flame, Snowflake, Zap,
    // Social
    Users, UserPlus, MessageCircle, MessagesSquare, AtSign, Share2,
    Link, Globe, MapPin, Navigation, Compass, Home, Building2,
    Church, Landmark, School, GraduationCap, BookOpen, Library,
    // Travel
    Plane, Car, Train, Bus, Ship, Anchor, Map, Luggage,
    Ticket, Hotel, Bed, Sofa, Armchair, Lamp, Tv, Radio,
    Wifi, Battery, Plug, Power, Lightbulb,
    // Fallback
    Sparkles,
};

interface DynamicIconProps extends Omit<LucideProps, 'ref'> {
    name: string;
    fallback?: LucideIcon;
}

/**
 * DynamicIcon renders a Lucide icon by name
 */
export const DynamicIcon: React.FC<DynamicIconProps> = memo(({ 
    name, 
    fallback: FallbackIcon = Sparkles,
    ...props 
}) => {
    const Icon = ICON_MAP[name] || FallbackIcon;
    return <Icon {...props} />;
});

DynamicIcon.displayName = 'DynamicIcon';

export default DynamicIcon;

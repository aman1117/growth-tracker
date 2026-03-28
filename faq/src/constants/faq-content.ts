import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Download,
  HelpCircle,
  LogIn,
  Shield,
  Smartphone,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export interface FAQItem {
  id: string;
  question: string;
  answer: string;
  steps?: InstallStep[];
}

export interface InstallStep {
  text: string;
  hint?: string;
}

export interface FAQCategory {
  id: string;
  label: string;
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  items: FAQItem[];
}

// ============================================================================
// Content
// ============================================================================

export const FAQ_CATEGORIES: FAQCategory[] = [
  // ---- About ----
  {
    id: 'about',
    label: 'About',
    icon: HelpCircle,
    iconBg: 'rgba(59, 130, 246, 0.1)',
    iconColor: '#3b82f6',
    items: [
      {
        id: 'what-is',
        question: 'What is Growth Tracker?',
        answer:
          'Growth Tracker helps you track every hour of your day, build better habits, and grow intentionally. Log activities, visualize trends with analytics, earn badges for consistency, and connect with friends for accountability.',
      },
      {
        id: 'is-it-free',
        question: 'Is Growth Tracker free?',
        answer:
          'Yes, Growth Tracker is completely free to use. There are no hidden fees, subscriptions, or in-app purchases.',
      },
      {
        id: 'how-it-works',
        question: 'How does Growth Tracker work?',
        answer:
          'Each day is divided into hourly tiles. Tap any tile to log what you were doing during that hour. Over time, you\'ll see patterns in your analytics dashboard. You can customize your activity categories, set daily goals, and follow friends to stay motivated.',
      },
      {
        id: 'what-can-i-track',
        question: 'What can I track?',
        answer:
          'You can track any activity — work, study, exercise, reading, sleep, hobbies, and more. Customize your activity categories with labels and colors that make sense for your routine.',
      },
    ],
  },

  // ---- Install on Android ----
  {
    id: 'install-android',
    label: 'Install on Android',
    icon: Smartphone,
    iconBg: 'rgba(34, 197, 94, 0.1)',
    iconColor: '#22c55e',
    items: [
      {
        id: 'android-chrome',
        question: 'How do I install Growth Tracker on Android?',
        answer:
          'You can install Growth Tracker directly from your Chrome browser — no app store needed. It will appear on your home screen and work just like a regular app.',
        steps: [
          { text: 'Open Chrome and go to trackgrowth.in' },
          {
            text: 'Tap the three-dot menu (⋮) in the top-right corner',
            hint: 'You might also see an "Install app" banner at the bottom of the screen — tap that instead if it appears.',
          },
          { text: 'Select "Install app" or "Add to Home screen"' },
          { text: 'Tap "Install" in the confirmation dialog' },
          {
            text: 'Growth Tracker will appear on your home screen',
            hint: 'You can now open it like any other app — it works offline too.',
          },
        ],
      },
      {
        id: 'android-other-browsers',
        question: 'Can I install it from Samsung Internet or Firefox?',
        answer:
          'Yes! Most modern Android browsers support installing web apps. In Samsung Internet, tap the menu and look for "Add page to" → "Home screen". In Firefox, tap the three-dot menu and select "Install". The experience is the same once installed.',
      },
      {
        id: 'android-update',
        question: 'How does the app update on Android?',
        answer:
          'Growth Tracker updates automatically in the background whenever you\'re connected to the internet. You\'ll always have the latest version without needing to do anything. If a major update is available, you may see a prompt to refresh.',
      },
      {
        id: 'android-uninstall',
        question: 'How do I uninstall it on Android?',
        answer:
          'Long-press the Growth Tracker icon on your home screen and drag it to "Uninstall" or select "Remove". You can also go to Settings → Apps → Growth Tracker → Uninstall.',
      },
    ],
  },

  // ---- Install on iOS ----
  {
    id: 'install-ios',
    label: 'Install on iPhone / iPad',
    icon: Download,
    iconBg: 'rgba(99, 102, 241, 0.1)',
    iconColor: '#6366f1',
    items: [
      {
        id: 'ios-safari',
        question: 'How do I install Growth Tracker on iPhone or iPad?',
        answer:
          'You can install Growth Tracker from Safari — it\'ll appear on your home screen and work like a native app. Note: you must use Safari for this to work on iOS.',
        steps: [
          { text: 'Open Safari and go to trackgrowth.in' },
          {
            text: 'Tap the Share button (📤) at the bottom of the screen',
            hint: 'On iPad, the Share button is in the top-right toolbar.',
          },
          { text: 'Scroll down and tap "Add to Home Screen"' },
          {
            text: 'Tap "Add" in the top-right corner',
            hint: 'You can rename the app here if you\'d like.',
          },
          {
            text: 'Growth Tracker now appears on your home screen',
            hint: 'Open it from there for the best full-screen experience.',
          },
        ],
      },
      {
        id: 'ios-chrome',
        question: 'Can I install it from Chrome on iPhone?',
        answer:
          'Unfortunately, Chrome on iOS does not support the "Add to Home Screen" install feature. You need to use Safari to install Growth Tracker on your home screen. After installation, you can continue using Chrome for other browsing — the installed app runs independently.',
      },
      {
        id: 'ios-update',
        question: 'How does the app update on iPhone?',
        answer:
          'Growth Tracker updates automatically when you open the app and are connected to the internet. There\'s nothing you need to do — you\'ll always have the latest version.',
      },
      {
        id: 'ios-uninstall',
        question: 'How do I uninstall it on iPhone?',
        answer:
          'Long-press the Growth Tracker icon on your home screen, then tap "Remove App" → "Delete". This works the same as removing any other app.',
      },
    ],
  },

  // ---- Notifications ----
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    iconBg: 'rgba(249, 115, 22, 0.1)',
    iconColor: '#f97316',
    items: [
      {
        id: 'notif-enable',
        question: 'How do I enable notifications?',
        answer:
          'Go to Settings in Growth Tracker and toggle on "Push Notifications". You\'ll be asked to allow notifications — tap "Allow" when prompted. Make sure you\'ve installed the app to your home screen for the best notification experience.',
      },
      {
        id: 'notif-not-working',
        question: 'Why am I not receiving notifications?',
        answer:
          'There are several things to check if notifications aren\'t arriving:',
        steps: [
          { text: 'Make sure notifications are enabled in Growth Tracker Settings' },
          {
            text: 'Check your device\'s notification settings',
            hint: 'On Android: Settings → Apps → Growth Tracker → Notifications. On iOS: Settings → Notifications → Growth Tracker.',
          },
          {
            text: 'Ensure "Do Not Disturb" or "Focus" mode is not active',
          },
          {
            text: 'Make sure you\'re connected to the internet',
            hint: 'Notifications require an active connection to be delivered.',
          },
          {
            text: 'Try toggling notifications off and on again in the app',
          },
        ],
      },
      {
        id: 'notif-android-blocked',
        question: 'Notifications are blocked on Android — how do I fix it?',
        answer:
          'If you accidentally blocked notifications, you can re-enable them from your device settings.',
        steps: [
          { text: 'Open your phone\'s Settings app' },
          { text: 'Tap "Apps" or "App Management"' },
          { text: 'Find and tap "Growth Tracker"' },
          { text: 'Tap "Notifications"' },
          { text: 'Turn on "Allow notifications"' },
        ],
      },
      {
        id: 'notif-ios-blocked',
        question: 'Notifications are blocked on iPhone — how do I fix it?',
        answer:
          'If notifications were blocked on iOS, you may need to reinstall the app to your home screen.',
        steps: [
          { text: 'Remove Growth Tracker from your home screen (long press → Remove)' },
          { text: 'Open Safari and go to trackgrowth.in' },
          { text: 'Tap Share (📤) → "Add to Home Screen"' },
          { text: 'Open the app from your home screen' },
          {
            text: 'When prompted, tap "Enable" then "Allow" for notifications',
          },
        ],
      },
      {
        id: 'notif-desktop',
        question: 'How do I enable notifications on desktop?',
        answer:
          'On desktop browsers, you can enable notifications by clicking the lock icon in the address bar, finding "Notifications", and changing it to "Allow". Then refresh the page and enable notifications in Growth Tracker Settings.',
      },
    ],
  },

  // ---- Account ----
  {
    id: 'account',
    label: 'Account & Login',
    icon: LogIn,
    iconBg: 'rgba(168, 85, 247, 0.1)',
    iconColor: '#a855f7',
    items: [
      {
        id: 'account-create',
        question: 'How do I create an account?',
        answer:
          'Go to trackgrowth.in and tap "Register". Enter your email and create a password. You\'ll receive a verification email — click the link to confirm your account.',
      },
      {
        id: 'account-forgot-password',
        question: 'I forgot my password — how do I reset it?',
        answer:
          'On the login page, tap "Forgot Password". Enter your email address and you\'ll receive a password reset link. Click the link to set a new password. The link expires after a limited time, so use it promptly.',
      },
      {
        id: 'account-email-not-received',
        question: 'I didn\'t receive the verification or reset email',
        answer:
          'Check your spam or junk folder first. Make sure you entered the correct email address. If you still don\'t see it, wait a few minutes and try again. Emails are sent from noreply@trackgrowth.in — you can add this to your contacts to prevent future emails from going to spam.',
      },
      {
        id: 'account-change-password',
        question: 'How do I change my password?',
        answer:
          'Open the app, go to Settings, and look for the password change option. You\'ll need to enter your current password and then set a new one.',
      },
      {
        id: 'account-delete',
        question: 'Can I delete my account?',
        answer:
          'If you want to delete your account and all associated data, please contact us at support@trackgrowth.in. We\'ll process your request and permanently remove your data.',
      },
    ],
  },

  // ---- Privacy ----
  {
    id: 'privacy',
    label: 'Privacy & Data',
    icon: Shield,
    iconBg: 'rgba(20, 184, 166, 0.1)',
    iconColor: '#14b8a6',
    items: [
      {
        id: 'privacy-data-collected',
        question: 'What data does Growth Tracker collect?',
        answer:
          'We collect only what\'s necessary to provide the service: your email address, profile information you choose to share, and the activity data you log. We do not collect location data, contacts, or any information from other apps on your device.',
      },
      {
        id: 'privacy-data-sold',
        question: 'Is my data sold to third parties?',
        answer:
          'No. We never sell, rent, or share your personal data with third parties for advertising or marketing purposes. Your data is yours.',
      },
      {
        id: 'privacy-data-security',
        question: 'How is my data kept secure?',
        answer:
          'Your data is stored securely with encryption in transit and at rest. We use industry-standard security practices including secure authentication, encrypted connections (HTTPS), and regularly updated infrastructure.',
      },
      {
        id: 'privacy-data-export',
        question: 'Can I export my data?',
        answer:
          'If you\'d like a copy of your data, contact us at support@trackgrowth.in and we\'ll provide an export for you.',
      },
      {
        id: 'privacy-who-sees',
        question: 'Who can see my activity data?',
        answer:
          'By default, your profile is visible to other Growth Tracker users who follow you. You can control your visibility in Settings. Your detailed hourly activity data is only visible to you — followers see a summary view only.',
      },
    ],
  },
];

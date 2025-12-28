# Growth Tracker Android App

A modern Android application for tracking personal growth activities, built with Kotlin and Jetpack Compose.

## 🚀 Features

- **User Authentication**: Register and login with email/username and password
- **Activity Tracking**: Log time spent on 16 different activity categories
- **Streak Tracking**: Monitor your current and longest activity streaks
- **Date Navigation**: View and edit historical activity data
- **User Search**: Find and view other users' dashboards
- **Dark Mode**: Full support for system dark/light themes
- **Material Design 3**: Modern, beautiful UI following latest guidelines

## 🛠 Tech Stack

- **Language**: Kotlin
- **UI**: Jetpack Compose + Material Design 3
- **Architecture**: MVVM + Clean Architecture
- **Dependency Injection**: Hilt
- **Networking**: Retrofit + OkHttp + Kotlinx Serialization
- **Local Storage**: DataStore Preferences
- **Navigation**: Jetpack Navigation Compose
- **Async**: Kotlin Coroutines + Flow

## 📱 Activity Categories

| Category | Icon |
|----------|------|
| Sleep | 🌙 |
| Study | 📖 |
| Book Reading | 📚 |
| Eating | 🍽️ |
| Friends | 👥 |
| Grooming | ✨ |
| Workout | 💪 |
| Reels | 🎬 |
| Family | 🏠 |
| Idle | ☕ |
| Creative | 🎨 |
| Travelling | ✈️ |
| Errand | 🛍️ |
| Rest | 🛋️ |
| Entertainment | 🎮 |
| Office | 💼 |

## 🏗 Project Structure

```
app/
├── di/                          # Hilt dependency injection modules
├── data/
│   ├── local/                   # DataStore for token management
│   ├── remote/
│   │   ├── api/                 # Retrofit API interface
│   │   ├── dto/                 # Data Transfer Objects
│   │   └── interceptor/         # Auth interceptor
│   └── repository/              # Repository implementations
├── domain/
│   ├── model/                   # Domain models
│   └── repository/              # Repository interfaces
├── presentation/
│   ├── components/              # Reusable composables
│   ├── navigation/              # Navigation graph
│   ├── screens/
│   │   ├── auth/                # Login/Register screen
│   │   ├── dashboard/           # Main dashboard
│   │   └── splash/              # Splash screen
│   └── theme/                   # Colors, Typography, Theme
└── util/                        # Utility classes
```

## 🚦 Getting Started

### Prerequisites

- Android Studio Hedgehog (2023.1.1) or newer
- JDK 17
- Android SDK 34

### Setup

1. Clone the repository
2. Open the `android` folder in Android Studio
3. Wait for Gradle sync to complete
4. Run the app on an emulator or physical device

### Build

```bash
# Debug build
./gradlew assembleDebug

# Release build
./gradlew assembleRelease
```

## 🔗 API Configuration

The app connects to the Growth Tracker backend API. The base URL is configured in `app/build.gradle.kts`:

```kotlin
buildConfigField("String", "BASE_URL", "\"https://northern-mariellen-aman1117-e5652442.koyeb.app\"")
```

## 📝 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | User login |
| POST | `/register` | User registration |
| POST | `/users` | Search users |
| POST | `/create-activity` | Log activity |
| POST | `/get-activities` | Get activities for date |
| POST | `/get-streak` | Get streak info |

## 🎨 Screenshots

*Coming soon*

## 📄 License

This project is part of the Growth Tracker application.

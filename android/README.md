# Growth Tracker Android App

A professional Android application for tracking personal growth activities, built with Jetpack Compose and Kotlin.

## Features

- ✅ **User Authentication** - Secure login and registration with JWT tokens
- 📊 **Activity Tracking** - Log 16 different daily activities with customizable hours
- 🔥 **Streak Tracking** - Monitor current and longest activity streaks
- 📅 **Date Navigation** - Browse and update activities by date
- 🎨 **Material Design 3** - Modern UI with dynamic colors and theming
- 📱 **Responsive Grid Layout** - 4-column activity grid matching web app design

## Tech Stack

- **Language:** Kotlin
- **UI Framework:** Jetpack Compose with Material Design 3
- **Architecture:** MVVM (Model-View-ViewModel)
- **Networking:** Retrofit + OkHttp
- **Serialization:** Kotlinx Serialization
- **Navigation:** Jetpack Navigation Compose
- **Data Storage:** DataStore (Preferences)
- **Dependency Injection:** Manual (constructor injection)
- **Min SDK:** 26 (Android 8.0)
- **Target SDK:** 34 (Android 14)

## Project Structure

```
app/
├── data/
│   ├── api/
│   │   ├── ApiService.kt          # Retrofit API definitions
│   │   └── RetrofitClient.kt      # Retrofit configuration
│   ├── model/
│   │   └── Models.kt              # Data models and enums
│   ├── preferences/
│   │   └── UserPreferences.kt     # DataStore for auth persistence
│   └── repository/
│       └── GrowthTrackerRepository.kt  # Data layer abstraction
├── ui/
│   ├── auth/
│   │   ├── AuthViewModel.kt       # Authentication state management
│   │   └── AuthScreen.kt          # Login/Register UI
│   ├── dashboard/
│   │   ├── DashboardViewModel.kt  # Dashboard state management
│   │   └── DashboardScreen.kt     # Activity grid and tracking UI
│   └── theme/
│       ├── Color.kt               # Color definitions
│       ├── Theme.kt               # Material 3 theme
│       └── Type.kt                # Typography styles
├── Navigation.kt                   # App navigation graph
└── MainActivity.kt                 # App entry point
```

## Setup Instructions

### Prerequisites

- Android Studio Hedgehog (2023.1.1) or newer
- JDK 17 or higher
- Android SDK with API level 34

### Installation

1. Open Android Studio
2. Select "Open an Existing Project"
3. Navigate to `growth-tracker/android/` directory
4. Wait for Gradle sync to complete
5. Run the app on an emulator or physical device

### Build Commands

```bash
# Clean build
./gradlew clean

# Build debug APK
./gradlew assembleDebug

# Build release APK
./gradlew assembleRelease

# Install and run on connected device
./gradlew installDebug
```

## API Configuration

The app connects to the Growth Tracker backend API:
- **Base URL:** `https://northern-mariellen-aman1117-e5652442.koyeb.app/`

To change the API endpoint, edit [RetrofitClient.kt](app/src/main/java/com/growthtracker/app/data/api/RetrofitClient.kt):

```kotlin
private const val BASE_URL = "YOUR_API_URL_HERE"
```

## App Features

### Authentication Screen
- Toggle between Login and Register modes
- Email validation for registration
- Username and password authentication
- JWT token storage with DataStore
- Error handling and loading states

### Dashboard Screen
- **Activity Grid:** 4x4 grid displaying 16 activity types
- **Activity Icons:** Material icons representing each activity
- **Color Coding:** Activities highlighted when logged (matching web app colors)
- **Date Navigator:** Browse previous days, navigate up to today
- **Streak Card:** Shows current and longest streaks
- **Activity Dialog:** Log hours in 0.25 increments (0.25, 0.5, 0.75, 1.0, etc.)
- **Real-time Updates:** Activities update immediately after saving

### Activity Types

| Activity | Icon | Color |
|----------|------|-------|
| Sleep | 🌙 | Indigo |
| Study | 📖 | Blue |
| Book Reading | 📚 | Sky Blue |
| Eating | 🍽️ | Amber |
| Friends | 👥 | Pink |
| Grooming | ✨ | Violet |
| Workout | 💪 | Red |
| Reels | 🎬 | Rose |
| Family | 🏠 | Emerald |
| Idle | ☕ | Slate |
| Creative | 🎨 | Fuchsia |
| Travelling | ✈️ | Cyan |
| Errand | 🛍️ | Orange |
| Rest | 🛋️ | Lime |
| Entertainment | 🎮 | Purple |
| Office | 💼 | Teal |

## Design Principles

- **Consistency:** UI matches React web app design language
- **Responsiveness:** Adapts to different screen sizes
- **Performance:** Efficient state management with StateFlow
- **Security:** Secure token storage, HTTPS-only communication
- **User Experience:** Loading states, error handling, validation
- **Material Design:** Following Material Design 3 guidelines

## Screenshots

The app closely replicates the web app's UI:
- Card-based layouts with elevation
- Activity tiles with icons and hour displays
- Streak indicator with fire emoji
- Date navigator with chevron buttons
- Modal dialog for activity input

## Development Notes

### State Management
- Uses Kotlin StateFlow for reactive UI updates
- ViewModels survive configuration changes
- Repository pattern for clean architecture

### Networking
- Retrofit with Kotlin Serialization converter
- HTTP logging for debugging
- Token-based authentication with Bearer scheme
- Automatic token refresh on 401 responses

### Data Persistence
- DataStore (Preferences) for auth tokens
- Persistent login across app restarts
- Secure credential storage

## Building for Production

1. Update `versionCode` and `versionName` in `app/build.gradle.kts`
2. Configure signing keys in `gradle.properties`
3. Build release APK:
   ```bash
   ./gradlew assembleRelease
   ```
4. Output APK location: `app/build/outputs/apk/release/`

## Troubleshooting

### Common Issues

**Gradle Sync Failed**
- Ensure you have JDK 17 installed
- Check internet connection for dependency downloads
- Try: File → Invalidate Caches → Invalidate and Restart

**App Crashes on Launch**
- Check Logcat for error messages
- Verify API endpoint is accessible
- Ensure internet permission in AndroidManifest.xml

**API Connection Issues**
- Verify device/emulator has internet access
- Check if backend API is running
- Test API endpoint in browser

## Contributing

This app is designed to maintain feature parity with the React web application. When adding new features:
1. Update backend API first
2. Add corresponding models in `Models.kt`
3. Extend API service in `ApiService.kt`
4. Update repository methods
5. Add ViewModel logic
6. Implement UI in Compose

## License

This project is part of the Growth Tracker application suite.

## Contact

For issues or questions, please refer to the main project repository.

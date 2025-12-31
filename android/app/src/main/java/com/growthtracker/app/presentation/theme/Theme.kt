package com.growthtracker.app.presentation.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

// Custom color scheme for additional colors not in Material3
data class GrowthTrackerColors(
    val accent: Color,
    val accentHover: Color,
    val progressTrack: Color,
    val logoBg: Color,
    val logoColor: Color,
    val avatarBg: Color,
    val iconBgMuted: Color,
    val skeletonBg: Color,
    val headerBg: Color,
    val success: Color,
    val streakGold: Color
)

val LocalGrowthTrackerColors = staticCompositionLocalOf {
    GrowthTrackerColors(
        accent = StreakGoldLight,
        accentHover = StreakGoldHover,
        progressTrack = ProgressTrackLight,
        logoBg = LogoBgLight,
        logoColor = LogoColorLight,
        avatarBg = AvatarBgLight,
        iconBgMuted = IconBgMutedLight,
        skeletonBg = SkeletonBgLight,
        headerBg = HeaderBgLight,
        success = Success,
        streakGold = StreakGoldLight
    )
}

private val LightColorScheme = lightColorScheme(
    primary = PrimaryLight,
    onPrimary = OnPrimaryLight,
    primaryContainer = PrimaryContainerLight,
    onPrimaryContainer = OnPrimaryContainerLight,
    secondary = SecondaryLight,
    onSecondary = OnSecondaryLight,
    secondaryContainer = SecondaryContainerLight,
    onSecondaryContainer = OnSecondaryContainerLight,
    tertiary = TertiaryLight,
    onTertiary = OnTertiaryLight,
    tertiaryContainer = TertiaryContainerLight,
    onTertiaryContainer = OnTertiaryContainerLight,
    background = BackgroundLight,
    onBackground = OnBackgroundLight,
    surface = SurfaceLight,
    onSurface = OnSurfaceLight,
    surfaceVariant = SurfaceVariantLight,
    onSurfaceVariant = OnSurfaceVariantLight,
    error = ErrorLight,
    onError = OnErrorLight,
    errorContainer = ErrorContainerLight,
    onErrorContainer = OnErrorContainerLight,
    outline = OutlineLight,
    outlineVariant = OutlineVariantLight
)

private val DarkColorScheme = darkColorScheme(
    primary = PrimaryDark,
    onPrimary = OnPrimaryDark,
    primaryContainer = PrimaryContainerDark,
    onPrimaryContainer = OnPrimaryContainerDark,
    secondary = SecondaryDark,
    onSecondary = OnSecondaryDark,
    secondaryContainer = SecondaryContainerDark,
    onSecondaryContainer = OnSecondaryContainerDark,
    tertiary = TertiaryDark,
    onTertiary = OnTertiaryDark,
    tertiaryContainer = TertiaryContainerDark,
    onTertiaryContainer = OnTertiaryContainerDark,
    background = BackgroundDark,
    onBackground = OnBackgroundDark,
    surface = SurfaceDark,
    onSurface = OnSurfaceDark,
    surfaceVariant = SurfaceVariantDark,
    onSurfaceVariant = OnSurfaceVariantDark,
    error = ErrorDark,
    onError = OnErrorDark,
    errorContainer = ErrorContainerDark,
    onErrorContainer = OnErrorContainerDark,
    outline = OutlineDark,
    outlineVariant = OutlineVariantDark
)

private val LightGrowthTrackerColors = GrowthTrackerColors(
    accent = StreakGoldLight,
    accentHover = StreakGoldHover,
    progressTrack = ProgressTrackLight,
    logoBg = LogoBgLight,
    logoColor = LogoColorLight,
    avatarBg = AvatarBgLight,
    iconBgMuted = IconBgMutedLight,
    skeletonBg = SkeletonBgLight,
    headerBg = HeaderBgLight,
    success = Success,
    streakGold = StreakGoldLight
)

private val DarkGrowthTrackerColors = GrowthTrackerColors(
    accent = StreakGold,
    accentHover = StreakGoldHover,
    progressTrack = ProgressTrackDark,
    logoBg = LogoBgDark,
    logoColor = LogoColorDark,
    avatarBg = AvatarBgDark,
    iconBgMuted = IconBgMutedDark,
    skeletonBg = SkeletonBgDark,
    headerBg = HeaderBgDark,
    success = SuccessDark,
    streakGold = StreakGold
)

// Theme state holder for manual toggle
class ThemeState(initialDarkTheme: Boolean) {
    var isDark by mutableStateOf(initialDarkTheme)
        private set
    
    fun toggleTheme() {
        isDark = !isDark
    }
}

val LocalThemeState = compositionLocalOf<ThemeState> { error("No ThemeState provided") }

@Composable
fun GrowthTrackerTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit
) {
    val themeState = remember { ThemeState(darkTheme) }
    val useDarkTheme = themeState.isDark
    
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (useDarkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        useDarkTheme -> DarkColorScheme
        else -> LightColorScheme
    }
    
    val growthTrackerColors = if (useDarkTheme) DarkGrowthTrackerColors else LightGrowthTrackerColors
    
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            window.navigationBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !useDarkTheme
            WindowCompat.getInsetsController(window, view).isAppearanceLightNavigationBars = !useDarkTheme
        }
    }

    CompositionLocalProvider(
        LocalGrowthTrackerColors provides growthTrackerColors,
        LocalThemeState provides themeState
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = Typography,
            content = content
        )
    }
}

// Extension to easily access custom colors
object GrowthTrackerTheme {
    val colors: GrowthTrackerColors
        @Composable
        get() = LocalGrowthTrackerColors.current
}

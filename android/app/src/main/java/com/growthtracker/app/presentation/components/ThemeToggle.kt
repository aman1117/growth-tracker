package com.growthtracker.app.presentation.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import com.growthtracker.app.presentation.theme.GrowthTrackerTheme
import com.growthtracker.app.presentation.theme.LocalThemeState

@Composable
fun ThemeToggle(
    modifier: Modifier = Modifier
) {
    val themeState = LocalThemeState.current
    val isDark = themeState.isDark
    
    // Animation for sun icon
    val sunRotation by animateFloatAsState(
        targetValue = if (isDark) -90f else 0f,
        animationSpec = tween(300),
        label = "sunRotation"
    )
    val sunScale by animateFloatAsState(
        targetValue = if (isDark) 0f else 1f,
        animationSpec = tween(300),
        label = "sunScale"
    )
    val sunAlpha by animateFloatAsState(
        targetValue = if (isDark) 0f else 1f,
        animationSpec = tween(300),
        label = "sunAlpha"
    )
    
    // Animation for moon icon
    val moonRotation by animateFloatAsState(
        targetValue = if (isDark) 0f else 90f,
        animationSpec = tween(300),
        label = "moonRotation"
    )
    val moonScale by animateFloatAsState(
        targetValue = if (isDark) 1f else 0f,
        animationSpec = tween(300),
        label = "moonScale"
    )
    val moonAlpha by animateFloatAsState(
        targetValue = if (isDark) 1f else 0f,
        animationSpec = tween(300),
        label = "moonAlpha"
    )
    
    Box(
        modifier = modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(GrowthTrackerTheme.colors.avatarBg)
            .clickable { themeState.toggleTheme() },
        contentAlignment = Alignment.Center
    ) {
        // Sun icon (visible in dark mode to switch to light)
        Icon(
            imageVector = Icons.Outlined.LightMode,
            contentDescription = "Switch to light mode",
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .size(16.dp)
                .rotate(sunRotation)
                .scale(sunScale)
                .graphicsLayer { alpha = sunAlpha }
        )
        
        // Moon icon (visible in light mode to switch to dark)
        Icon(
            imageVector = Icons.Outlined.DarkMode,
            contentDescription = "Switch to dark mode",
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .size(16.dp)
                .rotate(moonRotation)
                .scale(moonScale)
                .graphicsLayer { alpha = moonAlpha }
        )
    }
}
